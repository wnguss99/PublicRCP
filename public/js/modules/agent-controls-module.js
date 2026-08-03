/**
 * Agent Controls Module
 * Manages visibility of Start/Stop/Restart buttons, agent running indicator,
 * cancel button, input area state, and Ralph Loop controls integration.
 */
(function(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AgentControlsModule = factory();
  }
}(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  var state;
  var findProjectById;
  var updateProjectStatusById;
  var updateInputHint;
  var updateRalphLoopPauseButton;

  // --- Working indicator (VS Code "Forging…" style) ---
  // Gerund verbs cycled while the agent is actively working.
  var WORKING_VERBS = [
    'Forging', 'Brewing', 'Conjuring', 'Crafting', 'Channeling',
    'Computing', 'Pondering', 'Synthesizing', 'Weaving', 'Tinkering',
    'Orchestrating', 'Manifesting', 'Percolating', 'Cogitating', 'Sculpting',
    'Assembling', 'Distilling', 'Wrangling', 'Calibrating', 'Hatching'
  ];
  var VERB_CHANGE_SECONDS = 4;

  // Internal indicator state, combined in refreshIndicator().
  var agentRunning = false;
  var agentWaiting = false;
  var ralphStatusText = null;
  var workingTimer = null;
  var workingStartTime = 0;
  var workingVerbIndex = 0;

  function init(deps) {
    state = deps.state;
    findProjectById = deps.findProjectById;
    updateProjectStatusById = deps.updateProjectStatusById;
    updateInputHint = deps.updateInputHint;
    updateRalphLoopPauseButton = deps.updateRalphLoopPauseButton;
  }

  function updateStartStopButtons() {
    var project = findProjectById(state.selectedProjectId);
    var isRunning = project && project.status === 'running';

    $('#loop-controls').addClass('hidden');

    if (isRunning) {
      $('#btn-start-agent').addClass('hidden');
      $('#btn-stop-agent').removeClass('hidden');
      $('#btn-restart-agent').removeClass('hidden');
    } else {
      $('#btn-start-agent').removeClass('hidden');
      $('#btn-stop-agent').addClass('hidden');
      $('#btn-restart-agent').addClass('hidden');
    }
  }

  function showAgentRunningIndicator(isRunning, statusText) {
    agentRunning = !!isRunning;
    ralphStatusText = statusText || null;
    if (!agentRunning) {
      agentWaiting = false;
    }
    refreshIndicator();
  }

  /**
   * Tells the indicator the agent is idle-waiting for user input.
   * While waiting, the working animation pauses (the agent isn't doing anything).
   */
  function setAgentWaiting(isWaiting) {
    agentWaiting = !!isWaiting;
    refreshIndicator();
  }

  /**
   * Single source of truth for the toolbar indicator. Combines:
   *   - not running        -> hidden
   *   - Ralph Loop text    -> fixed label, no animation
   *   - running + waiting  -> "Waiting for your input", no animation
   *   - running + working  -> animated "Forging… 12s" verb cycle
   */
  function refreshIndicator() {
    var container = $('#agent-working-indicator');
    var spinner = $('#agent-output-spinner');
    var label = $('#agent-status-label');

    if (!agentRunning) {
      stopWorkingAnimation();
      container.addClass('hidden');
      spinner.addClass('hidden');
      label.addClass('hidden');
      $('#conversation-container').removeClass('has-working-indicator');
      return;
    }

    container.removeClass('hidden');
    label.removeClass('hidden');
    $('#conversation-container').addClass('has-working-indicator');

    if (ralphStatusText) {
      stopWorkingAnimation();
      spinner.removeClass('hidden');
      label.text(ralphStatusText);
      return;
    }

    if (agentWaiting) {
      stopWorkingAnimation();
      spinner.addClass('hidden');
      label.text('Waiting for your input');
      return;
    }

    // Agent is actively working — animate.
    spinner.removeClass('hidden');
    startWorkingAnimation();
  }

  function startWorkingAnimation() {
    if (!workingTimer) {
      workingStartTime = Date.now();
      workingVerbIndex = Math.floor(Math.random() * WORKING_VERBS.length);
      workingTimer = setInterval(function() {
        var elapsed = Math.floor((Date.now() - workingStartTime) / 1000);
        if (elapsed > 0 && elapsed % VERB_CHANGE_SECONDS === 0) {
          workingVerbIndex = (workingVerbIndex + 1) % WORKING_VERBS.length;
        }
        renderWorkingLabel();
      }, 1000);
    }
    // Always refresh the label — the indicator element may have been re-rendered.
    renderWorkingLabel();
  }

  function formatElapsed(totalSeconds) {
    if (totalSeconds < 60) {
      return totalSeconds + 's';
    }
    var minutes = Math.floor(totalSeconds / 60);
    var seconds = totalSeconds % 60;
    return minutes + 'm' + seconds + 's';
  }

  function renderWorkingLabel() {
    var elapsed = Math.floor((Date.now() - workingStartTime) / 1000);
    var verb = WORKING_VERBS[workingVerbIndex];
    $('#agent-status-label').text(verb + '… ' + formatElapsed(elapsed));
  }

  function stopWorkingAnimation() {
    if (workingTimer) {
      clearInterval(workingTimer);
      workingTimer = null;
    }
  }

  function updateCancelButton() {
    var project = findProjectById(state.selectedProjectId);
    var isRunning = project && project.status === 'running';
    var isWaiting = project && project.isWaitingForInput;

    if (isRunning && !isWaiting) {
      $('#btn-cancel-agent').removeClass('hidden');
    } else {
      $('#btn-cancel-agent').addClass('hidden');
    }
  }

  // Re-asserts a usable composer; it cannot disable one.
  //
  // History: this once enabled the input unconditionally, which contradicted the
  // server (it runs on every agent_status, so it re-enabled the composer while a
  // prompt was pending and the send came back 400). The fix made it disable the
  // input from state.activePromptType instead — which removed the only thing
  // recovering a leaked prompt lock, so a stuck lock became permanent. Both
  // versions were wrong because two writers were guessing at the same property.
  //
  // Neither is possible now: ComposerGate.apply() only ever enables, and being
  // called on every agent_status makes this a repair pass rather than a decision.
  function updateInputArea() {
    ComposerGate.apply();
    updateInputHint();
  }

  function formatRalphLoopStatusForLabel(status) {
    var baseText;

    switch (status) {
      case 'worker_running': baseText = 'Worker running...'; break;
      case 'reviewer_running': baseText = 'Reviewer running...'; break;
      case 'paused': baseText = 'Ralph Loop paused'; break;
      default: baseText = 'Ralph Loop: ' + status; break;
    }

    if (state.ralphLoopCurrentIteration !== null && state.ralphLoopCurrentIteration !== undefined &&
        state.ralphLoopMaxTurns !== null && state.ralphLoopMaxTurns !== undefined) {
      var remainingTurns = state.ralphLoopMaxTurns - state.ralphLoopCurrentIteration;
      return baseText + ' (Iteration ' + state.ralphLoopCurrentIteration + '/' + state.ralphLoopMaxTurns +
             ', ' + remainingTurns + ' left)';
    }

    return baseText;
  }

  function updateRalphLoopControls(status) {
    var isActive = status && status !== 'idle' && status !== 'completed' && status !== 'failed';

    if (!isActive) {
      $('#btn-ralph-loop-pause').addClass('hidden');
      $('#btn-agent-mode').addClass('hidden');
      state.isRalphLoopRunning = false;

      var project = findProjectById(state.selectedProjectId);
      var isAgentRunning = project && project.status === 'running';

      ComposerGate.release('ralph');

      if (isAgentRunning) {
        updateStartStopButtons();
        updateInputArea();
      } else {
        showAgentRunningIndicator(false);
        $('#btn-stop-agent').addClass('hidden');
        $('#btn-restart-agent').addClass('hidden');
        ComposerGate.apply();

        if (state.selectedProjectId) {
          updateProjectStatusById(state.selectedProjectId, 'stopped');
        }
      }
    } else {
      var statusText = formatRalphLoopStatusForLabel(status);
      showAgentRunningIndicator(true, statusText);

      $('#btn-stop-agent').removeClass('hidden');
      $('#btn-restart-agent').removeClass('hidden');
      $('#btn-agent-mode').removeClass('hidden');

      updateRalphLoopPauseButton(status);

      if (status === 'paused' || status === 'worker_running' || status === 'reviewer_running') {
        $('#btn-ralph-loop-pause').removeClass('hidden');
      } else {
        $('#btn-ralph-loop-pause').addClass('hidden');
      }

      // Renewed on every Ralph status update, so freshness is the liveness test:
      // if the loop's events stop arriving (socket drop, crashed loop) the
      // tracked operation expires and state.isRalphLoopRunning is cleared, rather
      // than blocking agent starts forever. The composer stays usable regardless —
      // the loop no longer takes the input away.
      ComposerGate.hold('ralph', {
        ttlMs: ComposerGate.TTL.RALPH,
        isLive: function() {
          return state.isRalphLoopRunning === true;
        },
        projectId: state.selectedProjectId
      });
      state.isRalphLoopRunning = true;

      updateProjectStatusById(state.selectedProjectId, 'running');
    }
  }

  return {
    init: init,
    updateStartStopButtons: updateStartStopButtons,
    showAgentRunningIndicator: showAgentRunningIndicator,
    setAgentWaiting: setAgentWaiting,
    updateCancelButton: updateCancelButton,
    updateInputArea: updateInputArea,
    formatRalphLoopStatusForLabel: formatRalphLoopStatusForLabel,
    updateRalphLoopControls: updateRalphLoopControls
  };
}));

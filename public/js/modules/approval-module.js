/**
 * Approval Module
 * Renders inline tool-approval cards when Claude requests permission to run a tool
 * (via the embedded MCP permission-prompt server). Handles approval_request /
 * approval_resolved WebSocket events and the toolbar approvalMode toggle.
 */
(function(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ApprovalModule = factory();
  }
}(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  var state;
  var api;
  var showToast;
  var showErrorToast;

  // Map<projectId, Map<requestId, { toolName, input, createdAt }>>
  var pendingByProject = {};

  function init(deps) {
    state = deps.state;
    api = deps.api;
    showToast = deps.showToast;
    showErrorToast = deps.showErrorToast;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function summarizeInput(toolName, input) {
    if (!input || typeof input !== 'object') return '';
    if (toolName === 'Bash') {
      return input.command || '';
    }
    if (toolName === 'Write' || toolName === 'Edit' || toolName === 'Read') {
      return input.file_path || '';
    }
    try {
      return JSON.stringify(input, null, 2);
    } catch (e) {
      return String(input);
    }
  }

  function buildAllowAlwaysLabel(toolName, input) {
    if (toolName === 'Bash') {
      var command = (input && input.command) ? String(input.command).trim() : '';
      var firstWord = command.split(/\s+/)[0] || '';
      if (firstWord) {
        return 'Allow always (Bash ' + firstWord + ')';
      }
    }
    return 'Allow always (' + toolName + ')';
  }

  function buildCardHtml(pending) {
    var toolName = escapeHtml(pending.toolName || 'Tool');
    var summary = escapeHtml(summarizeInput(pending.toolName, pending.input));
    var requestId = escapeHtml(pending.requestId);
    var alwaysLabel = escapeHtml(buildAllowAlwaysLabel(pending.toolName, pending.input));

    return (
      '<div class="approval-card border border-amber-500/60 bg-amber-500/10 rounded p-3 my-2" ' +
      'data-request-id="' + requestId + '">' +
      '  <div class="text-sm font-semibold text-amber-300 mb-1">' +
      '    Permission needed: <span class="text-amber-100">' + toolName + '</span>' +
      '  </div>' +
      (summary
        ? '  <pre class="text-xs bg-black/40 text-amber-100 p-2 rounded overflow-x-auto whitespace-pre-wrap break-all max-h-40">' +
          summary + '</pre>'
        : '') +
      '  <div class="approval-actions flex flex-wrap gap-2 mt-2">' +
      '    <button class="approval-allow-btn bg-green-600 hover:bg-green-500 text-white px-3 py-1 rounded text-sm" ' +
      '            title="Allow this one tool call">Allow</button>' +
      '    <button class="approval-allow-always-btn bg-yellow-600 hover:bg-yellow-500 text-white px-3 py-1 rounded text-sm" ' +
      '            title="Allow this kind of tool call for the rest of this session AND save the rule to project settings">' +
      alwaysLabel + '</button>' +
      '    <button class="approval-deny-btn bg-red-600 hover:bg-red-500 text-white px-3 py-1 rounded text-sm">Deny</button>' +
      '  </div>' +
      '  <div class="approval-status text-xs text-amber-200/70 mt-1 hidden"></div>' +
      '</div>'
    );
  }

  function ensureProjectMap(projectId) {
    if (!pendingByProject[projectId]) pendingByProject[projectId] = {};
    return pendingByProject[projectId];
  }

  function handleApprovalRequest(payload) {
    var projectId = payload.projectId;
    var pending = payload.approval;
    if (!projectId || !pending || !pending.requestId) return;

    var map = ensureProjectMap(projectId);
    map[pending.requestId] = pending;

    if (state && state.selectedProjectId === projectId) {
      renderCard(pending);
    }
  }

  function handleApprovalResolved(payload) {
    if (!payload || !payload.requestId) return;
    // Remove from any project map
    Object.keys(pendingByProject).forEach(function(pid) {
      if (pendingByProject[pid] && pendingByProject[pid][payload.requestId]) {
        delete pendingByProject[pid][payload.requestId];
      }
    });

    var $card = $('.approval-card[data-request-id="' + payload.requestId + '"]');
    if ($card.length) {
      $card.find('.approval-actions').remove();
      var label = (payload.decision && payload.decision.behavior === 'allow')
        ? 'Approved'
        : 'Denied';
      var color = (payload.decision && payload.decision.behavior === 'allow')
        ? 'text-green-400'
        : 'text-red-400';
      $card.find('.approval-status')
        .removeClass('hidden')
        .removeClass('text-amber-200/70')
        .addClass(color)
        .text(label);
    }
  }

  function renderCard(pending) {
    // Append to the active conversation stream. Main = #conversation, one-off panes have their own.
    var $stream = $('#conversation');
    if (!$stream.length) return;
    // Skip if already rendered (e.g. on reconnect or duplicate WS delivery)
    if ($stream.find('.approval-card[data-request-id="' + pending.requestId + '"]').length) {
      return;
    }
    $stream.append(buildCardHtml(pending));
    // Scroll the conversation viewport, not the inner ul
    var $viewport = $('#conversation-container');
    if ($viewport.length) {
      $viewport.scrollTop($viewport.get(0).scrollHeight);
    }
  }

  function bindHandlers() {
    $(document).on('click', '.approval-allow-btn', function() {
      var $card = $(this).closest('.approval-card');
      resolve($card, 'allow');
    });
    $(document).on('click', '.approval-allow-always-btn', function() {
      var $card = $(this).closest('.approval-card');
      resolve($card, 'allow_always');
    });
    $(document).on('click', '.approval-deny-btn', function() {
      var $card = $(this).closest('.approval-card');
      resolve($card, 'deny');
    });
  }

  function resolve($card, decision) {
    var requestId = $card.data('request-id');
    var projectId = state && state.selectedProjectId;
    if (!requestId || !projectId) return;

    $card.find('.approval-actions button').prop('disabled', true).addClass('opacity-50 cursor-not-allowed');

    $.ajax({
      url: '/api/projects/' + encodeURIComponent(projectId) + '/approval/resolve',
      method: 'POST',
      contentType: 'application/json',
      data: JSON.stringify({ requestId: requestId, decision: decision }),
    })
      .done(function(res) {
        if (decision === 'allow_always' && res && res.persistedRule && showToast) {
          showToast('Saved allow rule: ' + res.persistedRule, 'info');
        }
      })
      .fail(function(xhr) {
        if (showErrorToast) showErrorToast(xhr, 'Failed to send approval');
        $card.find('.approval-actions button').prop('disabled', false).removeClass('opacity-50 cursor-not-allowed');
      });
  }

  /**
   * Re-render pending cards when user switches to a project (e.g. on reload).
   */
  function rehydrateForProject(projectId) {
    if (!projectId) return;
    $.get('/api/projects/' + encodeURIComponent(projectId) + '/approval/pending')
      .done(function(res) {
        if (!res || !Array.isArray(res.pending)) return;
        var map = ensureProjectMap(projectId);
        res.pending.forEach(function(p) {
          map[p.requestId] = p;
          renderCard(p);
        });
      })
      .fail(function() { /* non-fatal */ });
  }

  // --- Approval mode toggle ---

  function loadMode(projectId, cb) {
    if (!projectId) { cb && cb('auto'); return; }
    $.get('/api/projects/' + encodeURIComponent(projectId) + '/approval/mode')
      .done(function(res) { cb && cb((res && res.mode) || 'auto'); })
      .fail(function() { cb && cb('auto'); });
  }

  function setMode(projectId, mode, cb) {
    if (!projectId || (mode !== 'ask' && mode !== 'auto')) {
      cb && cb(false);
      return;
    }
    $.ajax({
      url: '/api/projects/' + encodeURIComponent(projectId) + '/approval/mode',
      method: 'PUT',
      contentType: 'application/json',
      data: JSON.stringify({ mode: mode }),
    })
      .done(function() {
        if (showToast) showToast('Approval mode: ' + (mode === 'ask' ? 'Ask each tool' : 'Auto-run'), 'info');
        cb && cb(true);
      })
      .fail(function(xhr) {
        if (showErrorToast) showErrorToast(xhr, 'Failed to change approval mode');
        cb && cb(false);
      });
  }

  return {
    init: init,
    bindHandlers: bindHandlers,
    handleApprovalRequest: handleApprovalRequest,
    handleApprovalResolved: handleApprovalResolved,
    rehydrateForProject: rehydrateForProject,
    loadMode: loadMode,
    setMode: setMode,
  };
}));

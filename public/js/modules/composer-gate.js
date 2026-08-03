/**
 * Composer Gate — keeps the chat composer usable, always.
 *
 * WHY THIS EXISTS
 * ---------------
 * Six unrelated call sites used to write `#input-message.disabled` directly
 * (prompt blocking, send-in-flight, start-in-flight, updateInputArea, the Ralph
 * loop, the permission-mode switch). None of them knew about the others, the
 * last writer won, and each released the input only if a specific event arrived.
 * On a phone behind Tailscale those events are exactly what goes missing, and a
 * composer that never re-enables leaves no way to drive the app at all — the
 * only escape was restarting the server. It happened twice in one day.
 *
 * THE INVARIANT
 * -------------
 * **The composer is never disabled. Not for a prompt, not while sending, not
 * during a restart — never.** apply() only ever writes `disabled = false`, so
 * there is no state, event ordering, or dropped frame that can lock the user
 * out. There is nothing to recover from because nothing takes usability away.
 *
 * That makes the whole class of bug unreachable rather than survivable. Earlier
 * attempts tried to bound how long a lock could hold the input (predicates,
 * TTLs, a hard ceiling, a manual unlock button). Every one of those still had a
 * window in which the user was stuck, and still required someone to notice and
 * act. Refusing to disable at all has no window.
 *
 * WHAT THE LOCKS ARE FOR NOW
 * --------------------------
 * hold()/release() no longer touch the DOM. They track in-flight operations so
 * their *logic* flags cannot get stuck either: state.messageSending,
 * agentStarting, isModeSwitching and isRalphLoopRunning make code paths return
 * early, so a stuck flag means the app silently ignores the user — invisible,
 * and worse than a greyed-out box. Each tracked operation therefore still needs
 * a fact-based isLive() and a capped ttlMs, and onLockReaped() clears the flag.
 *
 * The watchdog runs on its own interval plus visibility/focus/online, so it
 * never depends on the WebSocket or the status poll being alive.
 *
 * Do not write to the composer's disabled property anywhere, including here — a
 * test (composer-single-owner.test.js) fails the build if you do.
 */
(function(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ComposerGate = factory();
  }
}(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  var INPUT_ID = 'input-message';
  var SEND_BTN_ID = 'btn-send-message';
  var FORM_ID = 'form-send-message';
  // Kept only so a stale button from an older page load can be removed.
  var UNLOCK_BTN_ID = 'btn-composer-unlock';

  var TICK_MS = 1000;

  /**
   * No tracked operation may exceed this, whatever it asks for. It bounds how
   * long a logic flag (messageSending, isModeSwitching, …) can keep a code path
   * returning early; the composer itself is never disabled either way.
   */
  var MAX_TTL_MS = 5 * 60 * 1000;

  /** Suggested TTLs, exported so callers use named values instead of literals. */
  var TTL = {
    PROMPT: MAX_TTL_MS,
    COMPACTING: 2 * 60 * 1000,
    SENDING: 30 * 1000,
    STARTING: 2 * 60 * 1000,
    RALPH: 60 * 1000,
    MODE_SWITCH: 60 * 1000
  };

  /**
   * The control the user would click to answer each prompt type.
   *
   * Answering a card disables its buttons, so this is how hasAnswerableControl()
   * tells a pending prompt from a resolved one without trusting any event to
   * arrive. It no longer decides whether the composer is usable — it keeps
   * state.activePromptType from getting stuck, which would otherwise leave a
   * stale "answer the prompt above" hint on a perfectly usable input.
   */
  var PROMPT_ANSWER_SELECTORS = {
    question: '.question-options .question-option',
    permission: '.permission-actions .permission-btn',
    askuser: '.ask-user-option',
    plan_mode: '.plan-mode-actions button'
  };

  // reason -> { isLive, ttlMs, projectId, heldAt, meta }
  var locks = Object.create(null);
  var timer = null;
  var listenersBound = false;
  var deps = {};

  function nowMs() {
    return Date.now();
  }

  function byId(id) {
    return typeof document === 'undefined' ? null : document.getElementById(id);
  }

  function log(level, message, detail) {
    if (deps.log) {
      deps.log(level, message, detail);
    } else if (typeof console !== 'undefined' && console[level]) {
      console[level]('[ComposerGate] ' + message, detail || '');
    }
  }

  function init(options) {
    deps = options || {};
    removeLegacyUnlockControl();
    start();
    apply();
  }

  /** Hidden by the Tailwind `hidden` class, on the node or any ancestor. */
  function isHidden(node) {
    var el = node;

    while (el && el.classList) {
      if (el.classList.contains('hidden')) return true;
      el = el.parentElement;
    }

    return false;
  }

  /**
   * Can the user actually click something to clear this prompt?
   *
   * This is the single fact that decides whether a prompt lock is real:
   * - answered card  -> buttons disabled  -> false -> lock reaped
   * - replayed history card (already answered) -> false
   * - prompt whose card never rendered (dropped frame) -> false
   *
   * A composer disabled with nothing on screen to answer is the exact dead end
   * this module exists to make impossible, so "no control" always means "no lock".
   */
  function hasAnswerableControl(promptType) {
    var selector = PROMPT_ANSWER_SELECTORS[promptType];
    if (!selector || typeof document === 'undefined') return false;

    var nodes = document.querySelectorAll(selector);

    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].disabled) continue;
      if (isHidden(nodes[i])) continue;
      return true;
    }

    return false;
  }

  /**
   * Track an in-flight operation. Does NOT disable the composer — nothing does.
   *
   * Re-holding an existing reason renews it, which is how a repeating status
   * event (the Ralph loop) proves freshness: once the events stop, the TTL
   * expires and onLockReaped() clears the flag it was standing for.
   *
   * @param {string} reason stable key, e.g. 'sending'
   * @param {{isLive?: function(): boolean, ttlMs?: number, projectId?: string, meta?: any}} opts
   */
  function hold(reason, opts) {
    if (!reason) return;

    var o = opts || {};
    var ttl = typeof o.ttlMs === 'number' && o.ttlMs > 0 ? Math.min(o.ttlMs, MAX_TTL_MS) : TTL.SENDING;

    locks[reason] = {
      // A lock with no predicate cannot prove anything, so it only gets its TTL.
      isLive: typeof o.isLive === 'function' ? o.isLive : null,
      ttlMs: ttl,
      projectId: o.projectId || null,
      heldAt: nowMs(),
      meta: o.meta || null
    };

    apply();
  }

  function release(reason) {
    if (!reason || !locks[reason]) {
      apply();
      return;
    }

    delete locks[reason];
    apply();
  }

  /** Drop every tracked operation. Used on project switches. */
  function releaseAll(cause) {
    var reasons = activeReasons();

    if (reasons.length > 0) {
      log('warn', 'Releasing all composer locks', { cause: cause || 'unspecified', reasons: reasons });
    }

    locks = Object.create(null);
    apply();

    if (reasons.length > 0 && deps.onForceRelease) {
      deps.onForceRelease(cause || 'unspecified', reasons);
    }
  }

  function has(reason) {
    return !!locks[reason];
  }

  function activeReasons() {
    return Object.keys(locks);
  }

  function getMeta(reason) {
    return locks[reason] ? locks[reason].meta : null;
  }

  /**
   * Decide, from facts only, whether a tracked operation still exists.
   * Every branch that returns a string is a reason it is considered finished.
   */
  function deathReason(reason, lock) {
    if (nowMs() - lock.heldAt > lock.ttlMs) {
      return 'ttl expired after ' + lock.ttlMs + 'ms';
    }

    // An operation belonging to a project the user has left is not this
    // screen's business any more.
    if (lock.projectId && deps.getSelectedProjectId) {
      var selected = deps.getSelectedProjectId();
      if (selected && selected !== lock.projectId) {
        return 'lock belongs to another project';
      }
    }

    if (!lock.isLive) {
      return null; // TTL is its only guarantee; already checked above.
    }

    var live;

    try {
      live = lock.isLive();
    } catch (err) {
      // A predicate that throws cannot establish anything.
      return 'liveness predicate threw: ' + (err && err.message ? err.message : err);
    }

    if (!live) {
      return 'liveness predicate returned false';
    }

    return null;
  }

  /**
   * One watchdog pass: retire finished operations, then force the composer back
   * into a usable state.
   *
   * apply() runs on every tick, not only when something changed, because its job
   * is to overrule the DOM rather than to reflect this module's bookkeeping. That
   * is what repairs a composer some other code disabled.
   */
  function tick() {
    var reasons = activeReasons();

    for (var i = 0; i < reasons.length; i++) {
      var reason = reasons[i];
      var lock = locks[reason];
      if (!lock) continue;

      var death = deathReason(reason, lock);

      if (death) {
        delete locks[reason];
        log('warn', 'Stale composer operation retired', { reason: reason, why: death });

        if (deps.onLockReaped) {
          deps.onLockReaped(reason, death, lock.meta);
        }
      }
    }

    apply();
  }

  /**
   * Force the composer into a usable state.
   *
   * Unconditional by design: there is no argument, no flag and no lock that can
   * make this disable the input. Anything that turned the composer off — this
   * app's own older code paths, a half-finished refactor, a browser extension —
   * is undone here and again on every tick.
   */
  function apply() {
    var input = byId(INPUT_ID);
    var sendBtn = byId(SEND_BTN_ID);
    var form = byId(FORM_ID);

    if (input) {
      input.disabled = false;
      input.readOnly = false;
      input.style.pointerEvents = '';
    }

    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.style.pointerEvents = '';
    }

    if (form) {
      // opacity-50 read as "disabled" even though typing worked, so it goes too.
      form.classList.remove('opacity-50');
      form.classList.remove('pointer-events-none');
      form.style.pointerEvents = '';
    }
  }

  /**
   * There is deliberately no unlock button.
   *
   * An earlier revision showed one whenever the composer was disabled. It was a
   * real escape hatch, but it made the user responsible for noticing a bug and
   * clearing it — and it only helped someone who understood what the button
   * meant. Since the composer is now never disabled, auto-recovery is the only
   * behaviour and there is nothing left to click.
   *
   * If a stale unlock button is still in the DOM (older markup, cached page),
   * remove it so it cannot confuse anyone.
   */
  function removeLegacyUnlockControl() {
    var stale = byId(UNLOCK_BTN_ID);

    if (stale && stale.parentNode) {
      stale.parentNode.removeChild(stale);
    }
  }

  function start() {
    if (typeof setInterval === 'undefined') return;

    stop();
    timer = setInterval(tick, TICK_MS);

    // The interval alone is not enough: mobile browsers freeze timers in
    // background tabs, so a tab resumed after a freeze must reconcile at once.
    // Bound once — restarting the watchdog must not stack duplicate listeners.
    if (listenersBound) return;

    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', onWake);
    }

    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('focus', onWake);
      window.addEventListener('online', onWake);
      window.addEventListener('pageshow', onWake);
    }

    listenersBound = true;
  }

  function onWake() {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    tick();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  /** Test seam: wipe all state without touching the DOM listeners. */
  function _reset() {
    locks = Object.create(null);
    deps = {};
    stop();
  }

  return {
    init: init,
    hold: hold,
    release: release,
    releaseAll: releaseAll,
    has: has,
    getMeta: getMeta,
    activeReasons: activeReasons,
    apply: apply,
    tick: tick,
    hasAnswerableControl: hasAnswerableControl,
    PROMPT_ANSWER_SELECTORS: PROMPT_ANSWER_SELECTORS,
    start: start,
    stop: stop,
    TTL: TTL,
    MAX_TTL_MS: MAX_TTL_MS,
    TICK_MS: TICK_MS,
    _reset: _reset
  };
}));

/**
 * ComposerGate behaviour tests.
 *
 * These encode the one rule the chat UI cannot get wrong: **the composer is
 * never disabled.** Each vector below is a way it went dead in production (or
 * could have); the assertion is always that the user can still type — with no
 * button to press, no event required, and no waiting.
 *
 * Vector labels (A/B/C/D) match the incident analysis for 2026-08-01.
 */
const path = require('path');

const ComposerGate = require(path.join(__dirname, '..', '..', 'public', 'js', 'modules', 'composer-gate.js'));

function buildDom() {
  document.body.innerHTML = `
    <div id="interactive-input-area">
      <form id="form-send-message">
        <textarea id="input-message"></textarea>
        <button id="btn-send-message" type="submit">Send</button>
      </form>
    </div>
    <div id="conversation"></div>
  `;
}

function input() {
  return document.getElementById('input-message');
}

function sendBtn() {
  return document.getElementById('btn-send-message');
}

/** The invariant, in one place. */
function isUsable() {
  return input().disabled === false &&
    input().readOnly === false &&
    sendBtn().disabled === false;
}

/** Render an AskUserQuestion card the way tool-renderer does. */
function renderAskUserCard(toolId, { answered = false } = {}) {
  const disabled = answered ? 'disabled' : '';
  document.getElementById('conversation').innerHTML += `
    <div class="ask-user-question" data-tool-id="${toolId}">
      <div class="ask-user-options">
        <button class="ask-user-option" ${disabled}>Option A</button>
        <button class="ask-user-option" ${disabled}>Option B</button>
      </div>
    </div>
  `;
}

function renderPlanCard({ answered = false } = {}) {
  const disabled = answered ? 'disabled' : '';
  document.getElementById('conversation').innerHTML += `
    <div class="plan-mode-actions">
      <button class="plan-approve-btn" ${disabled}>Approve</button>
      <button class="plan-reject-btn" ${disabled}>Reject</button>
    </div>
  `;
}

/** Run the watchdog as if `ms` had passed, without waiting for real time. */
function tickAfter(ms) {
  const realNow = Date.now;
  Date.now = () => realNow() + ms;

  try {
    ComposerGate.tick();
  } finally {
    Date.now = realNow;
  }
}

describe('ComposerGate', () => {
  beforeEach(() => {
    buildDom();
    ComposerGate._reset();
    ComposerGate.init({ getSelectedProjectId: () => 'proj-1' });
    ComposerGate.stop(); // drive tick() explicitly for determinism
  });

  afterEach(() => {
    ComposerGate.stop();
    ComposerGate._reset();
  });

  describe('the composer is never disabled', () => {
    it('starts usable', () => {
      expect(isUsable()).toBe(true);
    });

    it('stays usable while an operation is tracked', () => {
      ComposerGate.hold('sending', { isLive: () => true, ttlMs: 30000 });

      expect(ComposerGate.has('sending')).toBe(true);
      expect(isUsable()).toBe(true);
    });

    it('stays usable with every kind of operation held at once', () => {
      ['prompt', 'sending', 'starting', 'ralph', 'modeSwitch'].forEach((reason) => {
        ComposerGate.hold(reason, { isLive: () => true, ttlMs: 60000 });
      });

      ComposerGate.tick();

      expect(ComposerGate.activeReasons()).toHaveLength(5);
      expect(isUsable()).toBe(true);
    });

    it('stays usable while a real unanswered prompt is on screen', () => {
      renderAskUserCard('tool-live');
      ComposerGate.hold('prompt', {
        isLive: () => ComposerGate.hasAnswerableControl('askuser'),
        ttlMs: ComposerGate.TTL.PROMPT
      });

      ComposerGate.tick();

      // The card is answerable AND typing works — both routes stay open.
      expect(ComposerGate.has('prompt')).toBe(true);
      expect(isUsable()).toBe(true);
    });

    it('re-enables a composer that other code disabled behind its back (C3)', () => {
      input().disabled = true;
      sendBtn().disabled = true;

      ComposerGate.apply();

      expect(isUsable()).toBe(true);
    });

    it('undoes readonly, pointer-events and opacity lockouts', () => {
      input().readOnly = true;
      input().style.pointerEvents = 'none';
      document.getElementById('form-send-message').style.pointerEvents = 'none';
      document.getElementById('form-send-message').classList.add('opacity-50');

      ComposerGate.tick();

      expect(isUsable()).toBe(true);
      expect(input().style.pointerEvents).toBe('');
      expect(document.getElementById('form-send-message').classList.contains('opacity-50')).toBe(false);
    });

    it('repairs the composer on every tick, not only when locks change', () => {
      ComposerGate.hold('prompt', { isLive: () => true, ttlMs: 60000 });
      input().disabled = true; // something disabled it after the hold

      ComposerGate.tick();

      expect(isUsable()).toBe(true);
    });
  });

  describe('no user-facing recovery step', () => {
    it('never renders an unlock button', () => {
      ComposerGate.hold('prompt', { isLive: () => true, ttlMs: 60000 });
      ComposerGate.tick();

      expect(document.getElementById('btn-composer-unlock')).toBeNull();
    });

    it('removes a stale unlock button left by an older page load', () => {
      const stale = document.createElement('button');
      stale.id = 'btn-composer-unlock';
      document.getElementById('interactive-input-area').appendChild(stale);

      ComposerGate.init({ getSelectedProjectId: () => 'proj-1' });
      ComposerGate.stop();

      expect(document.getElementById('btn-composer-unlock')).toBeNull();
    });
  });

  describe('stale operations are retired so flags cannot wedge the app', () => {
    it('retires an operation whose predicate says it is done (A3)', () => {
      let live = true;
      ComposerGate.hold('prompt', { isLive: () => live, ttlMs: 300000 });

      live = false; // the CLI answered its own modal; no event reaches us
      ComposerGate.tick();

      expect(ComposerGate.has('prompt')).toBe(false);
      expect(isUsable()).toBe(true);
    });

    it('retires an operation whose predicate throws (D2)', () => {
      ComposerGate.hold('prompt', {
        isLive: () => { throw new Error('boom'); },
        ttlMs: 300000
      });

      ComposerGate.tick();

      expect(ComposerGate.has('prompt')).toBe(false);
    });

    it('retires a predicate-less operation on its TTL (B1: request never settles)', () => {
      ComposerGate.hold('sending', { ttlMs: 30000 });

      tickAfter(31000);

      expect(ComposerGate.has('sending')).toBe(false);
    });

    it('caps any TTL a caller asks for', () => {
      ComposerGate.hold('greedy', { isLive: () => true, ttlMs: 999 * 60 * 1000 });

      tickAfter(ComposerGate.MAX_TTL_MS + 1000);

      expect(ComposerGate.has('greedy')).toBe(false);
    });

    it('retires an operation belonging to a project the user has left (B2)', () => {
      ComposerGate.hold('starting', { isLive: () => true, ttlMs: 120000, projectId: 'proj-OTHER' });

      ComposerGate.tick();

      expect(ComposerGate.has('starting')).toBe(false);
    });

    it('reports each retirement so callers can clear their own flags (B3)', () => {
      const reaped = [];
      ComposerGate._reset();
      ComposerGate.init({
        getSelectedProjectId: () => 'proj-1',
        onLockReaped: (reason, why) => reaped.push({ reason, why })
      });
      ComposerGate.stop();

      ComposerGate.hold('sending', { isLive: () => false, ttlMs: 30000 });
      ComposerGate.tick();

      expect(reaped).toEqual([
        { reason: 'sending', why: 'liveness predicate returned false' }
      ]);
    });

    it('C1: a Ralph loop that stops emitting status clears its flag on the TTL', () => {
      let ralphRunning = true;
      ComposerGate.hold('ralph', { isLive: () => ralphRunning, ttlMs: ComposerGate.TTL.RALPH });

      tickAfter(ComposerGate.TTL.RALPH + 1000);

      expect(ComposerGate.has('ralph')).toBe(false);
      expect(ralphRunning).toBe(true); // proves the TTL, not the flag, retired it
    });

    it('C2: a mode switch whose requests never settle clears its flag', () => {
      ComposerGate.hold('modeSwitch', { isLive: () => true, ttlMs: ComposerGate.TTL.MODE_SWITCH });

      tickAfter(ComposerGate.TTL.MODE_SWITCH + 1000);

      expect(ComposerGate.has('modeSwitch')).toBe(false);
    });

    it('keeps an operation that is genuinely still running', () => {
      const pending = { state: () => 'pending' };
      ComposerGate.hold('sending', {
        isLive: () => pending.state() === 'pending',
        ttlMs: ComposerGate.TTL.SENDING
      });

      ComposerGate.tick();
      ComposerGate.tick();

      expect(ComposerGate.has('sending')).toBe(true);
      expect(isUsable()).toBe(true);
    });
  });

  describe('hasAnswerableControl — keeps the prompt hint honest', () => {
    it('is false with no card at all (A7: the plan frame never arrived)', () => {
      expect(ComposerGate.hasAnswerableControl('plan_mode')).toBe(false);
    });

    it('is true for a freshly rendered, unanswered question', () => {
      renderAskUserCard('tool-1');
      expect(ComposerGate.hasAnswerableControl('askuser')).toBe(true);
    });

    it('is false for a replayed, already answered card (A1)', () => {
      renderAskUserCard('tool-1', { answered: true });
      expect(ComposerGate.hasAnswerableControl('askuser')).toBe(false);
    });

    it('is false once the plan card has been clicked (A6)', () => {
      renderPlanCard();
      expect(ComposerGate.hasAnswerableControl('plan_mode')).toBe(true);

      document.querySelectorAll('.plan-mode-actions button')
        .forEach((b) => { b.disabled = true; });

      expect(ComposerGate.hasAnswerableControl('plan_mode')).toBe(false);
    });

    it('is false for a card hidden by an ancestor', () => {
      document.getElementById('conversation').innerHTML =
        '<div class="hidden"><div class="plan-mode-actions"><button>Approve</button></div></div>';
      expect(ComposerGate.hasAnswerableControl('plan_mode')).toBe(false);
    });

    it('is false for an unknown prompt type (A8: a future type gets no free pass)', () => {
      expect(ComposerGate.hasAnswerableControl('some_new_prompt')).toBe(false);
    });
  });

  describe('recovery never depends on the network', () => {
    it('D1: the watchdog runs without the WebSocket or the status poll', () => {
      jest.useFakeTimers();
      try {
        ComposerGate._reset();
        ComposerGate.init({ getSelectedProjectId: () => 'proj-1' });
        ComposerGate.hold('prompt', { isLive: () => false, ttlMs: ComposerGate.TTL.PROMPT });
        input().disabled = true; // simulate stray code disabling it

        jest.advanceTimersByTime(ComposerGate.TICK_MS + 50);

        expect(isUsable()).toBe(true);
        expect(ComposerGate.has('prompt')).toBe(false);
      } finally {
        ComposerGate.stop();
        jest.useRealTimers();
      }
    });

    it('D3: a tab resumed after a freeze reconciles immediately', () => {
      ComposerGate._reset();
      ComposerGate.init({ getSelectedProjectId: () => 'proj-1' });
      ComposerGate.hold('prompt', { isLive: () => false, ttlMs: ComposerGate.TTL.PROMPT });
      input().disabled = true;

      window.dispatchEvent(new Event('focus'));

      expect(isUsable()).toBe(true);
      ComposerGate.stop();
    });

    it('does not stack duplicate wake listeners when restarted', () => {
      const added = [];
      const original = window.addEventListener.bind(window);
      window.addEventListener = (type, fn) => { added.push(type); return original(type, fn); };

      try {
        ComposerGate.start();
        ComposerGate.start();
        ComposerGate.start();
      } finally {
        window.addEventListener = original;
        ComposerGate.stop();
      }

      expect(added).toEqual([]);
    });
  });
});

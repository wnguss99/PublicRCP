/**
 * @jest-environment jsdom
 */

/**
 * Refreshing appeared to delete the entire conversation history.
 *
 * It never did — the messages were always intact on disk (measured on the real
 * file: 1862 messages, 4.9 MB). Two things combined to present that as deletion:
 *
 *   1. selectProject() emptied `state.conversations[projectId]` *before* the
 *      reload, throwing away the last known good view.
 *   2. loadConversationHistory() had only a `.done()` handler. A conversation of
 *      several megabytes fetched in one request, from a phone over Tailscale,
 *      does fail — and when it did, nothing ran. The chat was left with the
 *      emptied cache and rendered the reassuring "No conversation yet".
 *
 * So the two rules asserted here are: a failed load never renders as an empty
 * conversation, and a failed load never destroys what is already on screen.
 */
const EscapeUtils = require('../../public/js/modules/escape-utils');

describe('conversation load failure', () => {
  const PROJECT = 'proj-1';
  let state;

  /** The shipped renderConversation() empty-state branch. */
  function renderConversation(projectId) {
    const conv = document.getElementById('conversation');
    const messages = state.conversations[projectId] || [];
    conv.innerHTML = '';

    const filtered = messages.filter((m) => m.type !== 'tool_result');

    if (filtered.length === 0) {
      const isLoading = (state.conversationLoading || {})[projectId];
      const loadError = (state.conversationLoadErrors || {})[projectId];

      if (isLoading) {
        conv.innerHTML = '<div class="loading">대화 이력을 불러오는 중</div>';
      } else if (loadError) {
        conv.innerHTML =
          '<div class="load-error">불러오지 못했습니다 (' +
          EscapeUtils.escapeHtml(loadError) +
          ')<button id="btn-retry-conversation">다시 시도</button></div>';
      } else {
        conv.innerHTML = '<div class="text-gray-500 text-center">No conversation yet</div>';
      }

      return;
    }

    filtered.forEach((m) => {
      const el = document.createElement('div');
      el.className = 'conversation-message';
      el.textContent = m.content || '';
      conv.appendChild(el);
    });
  }

  beforeEach(() => {
    document.body.innerHTML = '<div id="conversation"></div>';
    state = {
      conversations: {},
      conversationLoadErrors: {},
      conversationLoading: {},
      selectedProjectId: PROJECT,
    };
  });

  const someMessages = () => [
    { type: 'user', content: 'first' },
    { type: 'stdout', content: 'reply' },
  ];

  it('renders the history when the load succeeds', () => {
    state.conversations[PROJECT] = someMessages();
    renderConversation(PROJECT);

    expect(document.querySelectorAll('.conversation-message')).toHaveLength(2);
  });

  it('keeps the messages already on screen when a reload fails', () => {
    state.conversations[PROJECT] = someMessages();
    state.conversationLoadErrors[PROJECT] = 'HTTP 0';

    renderConversation(PROJECT);

    // selectProject no longer empties the cache, so the previous view survives.
    expect(document.querySelectorAll('.conversation-message')).toHaveLength(2);
  });

  it('never claims "No conversation yet" when the load failed', () => {
    state.conversations[PROJECT] = [];
    state.conversationLoadErrors[PROJECT] = 'HTTP 502';

    renderConversation(PROJECT);
    const html = document.getElementById('conversation').innerHTML;

    expect(html).not.toContain('No conversation yet');
    expect(html).toContain('불러오지 못했습니다');
    expect(html).toContain('HTTP 502');
  });

  it('offers a retry control when the load failed', () => {
    state.conversations[PROJECT] = [];
    state.conversationLoadErrors[PROJECT] = 'network error';

    renderConversation(PROJECT);

    expect(document.getElementById('btn-retry-conversation')).not.toBeNull();
  });

  it('still says "No conversation yet" for a genuinely empty conversation', () => {
    state.conversations[PROJECT] = [];
    state.conversationLoadErrors[PROJECT] = null;

    renderConversation(PROJECT);

    expect(document.getElementById('conversation').innerHTML).toContain('No conversation yet');
    expect(document.getElementById('btn-retry-conversation')).toBeNull();
  });

  it('escapes the error text so it cannot inject markup', () => {
    state.conversations[PROJECT] = [];
    state.conversationLoadErrors[PROJECT] = 'HTTP 0 <img src=x onerror="alert(1)">';

    renderConversation(PROJECT);
    const html = document.getElementById('conversation').innerHTML;

    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('tolerates conversationLoadErrors being absent entirely', () => {
    // A throw inside renderConversation is itself the blanking failure mode, so
    // the read must stay safe even if state was built without the field.
    delete state.conversationLoadErrors;
    delete state.conversationLoading;
    state.conversations[PROJECT] = [];

    expect(() => renderConversation(PROJECT)).not.toThrow();
    expect(document.getElementById('conversation').innerHTML).toContain('No conversation yet');
  });

  describe('while the load is still in flight', () => {
    // selectProject() fires loadConversationHistory() and then renders
    // synchronously two lines later. On a hard refresh the cache is empty and no
    // error has occurred yet, so the empty branch was reached with nothing to
    // distinguish "not loaded yet" from "no messages" — and it picked the
    // reassuring reading. On a multi-megabyte history over Tailscale that is
    // seconds of the chat asserting the conversation is empty when it is not.
    it('never claims "No conversation yet" while loading', () => {
      state.conversations[PROJECT] = [];
      state.conversationLoading[PROJECT] = true;

      renderConversation(PROJECT);
      const html = document.getElementById('conversation').innerHTML;

      expect(html).not.toContain('No conversation yet');
      expect(html).toContain('불러오는 중');
    });

    it('reports progress rather than the error a retry is retrying', () => {
      state.conversations[PROJECT] = [];
      state.conversationLoadErrors[PROJECT] = 'HTTP 502';
      state.conversationLoading[PROJECT] = true;

      renderConversation(PROJECT);
      const html = document.getElementById('conversation').innerHTML;

      expect(html).toContain('불러오는 중');
      expect(html).not.toContain('HTTP 502');
    });

    it('still shows cached messages instead of a spinner when it has some', () => {
      state.conversations[PROJECT] = someMessages();
      state.conversationLoading[PROJECT] = true;

      renderConversation(PROJECT);

      expect(document.querySelectorAll('.conversation-message')).toHaveLength(2);
    });
  });
});

/**
 * The tests above exercise a mirror of the shipped logic. These read the real
 * public/js/app.js, so the guards cannot be removed while the suite stays green.
 */
describe('app.js keeps its anti-blanking guards', () => {
  const fs = require('fs');
  const path = require('path');

  const APP_JS = fs.readFileSync(
    path.join(__dirname, '..', '..', 'public', 'js', 'app.js'),
    'utf8'
  );

  /** Slice a function out of the source by its signature and its next neighbour. */
  function sliceBetween(startSignature, endSignature) {
    const start = APP_JS.indexOf(startSignature);
    expect(start).toBeGreaterThan(-1);
    const end = APP_JS.indexOf(endSignature, start);
    expect(end).toBeGreaterThan(start);

    return APP_JS.slice(start, end);
  }

  const loadFn = () =>
    sliceBetween('function loadConversationHistory(projectId) {', 'function findProjectById(');
  const renderFn = () =>
    sliceBetween('function renderConversation(projectId) {', 'function restorePromptState(');

  it('marks the load in flight before issuing the request', () => {
    const body = loadFn();
    const marked = body.indexOf('state.conversationLoading[projectId] = true');
    const request = body.indexOf("$.get('/api/projects/");

    expect(marked).toBeGreaterThan(-1);
    expect(request).toBeGreaterThan(-1);
    // Ordering is the whole point: selectProject renders synchronously right
    // after this call returns, so setting the flag afterwards changes nothing.
    expect(marked).toBeLessThan(request);
  });

  it('clears the in-flight flag on success and on failure', () => {
    const body = loadFn();
    const cleared = body.match(/state\.conversationLoading\[projectId\] = false/g) || [];

    expect(cleared).toHaveLength(2);
  });

  it('consults the in-flight flag before claiming the conversation is empty', () => {
    const body = renderFn();
    const checked = body.indexOf('state.conversationLoading || {}');
    // The rendered markup, not the surrounding comment that also names it.
    const claim = body.indexOf('>No conversation yet<');

    expect(checked).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(checked);
  });

  it('reads both flags defensively, so a missing field cannot throw', () => {
    const body = renderFn();

    expect(body).toContain('(state.conversationLoading || {})');
    expect(body).toContain('(state.conversationLoadErrors || {})');
  });

  it('wraps each message render so one bad message cannot blank the rest', () => {
    const body = renderFn();
    const loop = body.slice(body.indexOf('filteredMessages.forEach'));

    // Everything in the loop runs after $conv.empty(), so an escaping exception
    // leaves the chat blank with the history intact on the server — the exact
    // report this file exists to make impossible.
    expect(loop).toMatch(/forEach\(function\(msg\)\s*\{\s*try\s*\{/);
    expect(loop).toContain('logRenderFailure');
  });

  it('guards every step that runs between emptying and appending', () => {
    const body = renderFn();
    const emptied = body.indexOf('$conv.empty()');
    const appended = body.indexOf('filteredMessages.forEach');

    expect(emptied).toBeGreaterThan(-1);
    expect(appended).toBeGreaterThan(emptied);

    // resetRenderingContext() sits in that window: it is called after the
    // container is cleared and before anything is put back, so an exception
    // there blanks the chat just as effectively as a bad message does.
    const between = body.slice(emptied, appended);
    expect(between).toMatch(/try\s*\{[\s\S]*resetRenderingContext\(\)/);
  });

  it('reports a render failure to the backend, not only to the console', () => {
    const start = APP_JS.indexOf('function logRenderFailure(');
    expect(start).toBeGreaterThan(-1);
    const body = APP_JS.slice(start, APP_JS.indexOf('function renderConversation(', start));

    // Claudito is driven from a phone over Tailscale. A console-only error is a
    // bug that nobody can ever see, which is how the first version of this
    // failure survived long enough to look like data loss.
    expect(body).toContain('logFrontendError');
  });
});

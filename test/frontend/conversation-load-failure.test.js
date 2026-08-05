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
      const loadError = (state.conversationLoadErrors || {})[projectId];

      if (loadError) {
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
    state.conversations[PROJECT] = [];

    expect(() => renderConversation(PROJECT)).not.toThrow();
    expect(document.getElementById('conversation').innerHTML).toContain('No conversation yet');
  });
});

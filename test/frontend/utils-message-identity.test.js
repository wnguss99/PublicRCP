/**
 * Utils.messageIdentity — the key that decides whether a chat message is a
 * re-delivery (drop it) or a distinct message (show it).
 *
 * The key was once `timestamp + type`. Timestamps are millisecond precision, so
 * two different messages of the same type produced in the same millisecond — which
 * happens whenever Claude issues parallel tool calls — collided, and the second was
 * silently dropped from the view even though the server had stored both. The output
 * reappeared on refresh, which from the outside looks exactly like the agent having
 * stalled mid-answer. These tests exist so that key never regresses to that.
 */
const Utils = require('../../public/js/utils.js');

describe('Utils.messageIdentity', () => {
  const TS = '2026-08-03T00:14:58.123Z';

  it('separates two different messages produced in the same millisecond', () => {
    const a = { timestamp: TS, type: 'stdout', content: 'first chunk' };
    const b = { timestamp: TS, type: 'stdout', content: 'second chunk' };

    expect(Utils.messageIdentity(a)).not.toBe(Utils.messageIdentity(b));
  });

  it('separates parallel tool calls that share a millisecond', () => {
    const a = { timestamp: TS, type: 'tool_use', toolInfo: { id: 'toolu_A' } };
    const b = { timestamp: TS, type: 'tool_use', toolInfo: { id: 'toolu_B' } };

    expect(Utils.messageIdentity(a)).not.toBe(Utils.messageIdentity(b));
  });

  it('matches the same message delivered twice', () => {
    const live = { timestamp: TS, type: 'stdout', content: 'the answer' };
    const fromHistory = { timestamp: TS, type: 'stdout', content: 'the answer' };

    expect(Utils.messageIdentity(live)).toBe(Utils.messageIdentity(fromHistory));
  });

  it('matches the same tool event delivered twice', () => {
    const live = { timestamp: TS, type: 'tool_use', toolInfo: { id: 'toolu_A', extra: 1 } };
    const fromHistory = { timestamp: TS, type: 'tool_use', toolInfo: { id: 'toolu_A' } };

    expect(Utils.messageIdentity(live)).toBe(Utils.messageIdentity(fromHistory));
  });

  it('separates different types at the same instant', () => {
    const a = { timestamp: TS, type: 'stdout', content: 'x' };
    const b = { timestamp: TS, type: 'system', content: 'x' };

    expect(Utils.messageIdentity(a)).not.toBe(Utils.messageIdentity(b));
  });

  it('separates long messages that share a prefix but differ in length', () => {
    const prefix = 'x'.repeat(64);
    const a = { timestamp: TS, type: 'stdout', content: prefix + 'short' };
    const b = { timestamp: TS, type: 'stdout', content: prefix + 'a much longer tail' };

    expect(Utils.messageIdentity(a)).not.toBe(Utils.messageIdentity(b));
  });

  it('handles missing and non-string content without throwing', () => {
    expect(() => Utils.messageIdentity({ timestamp: TS, type: 'stdout' })).not.toThrow();
    expect(() => Utils.messageIdentity({ timestamp: TS, type: 'result', content: { a: 1 } })).not.toThrow();
    expect(Utils.messageIdentity(null)).toBe('');
    expect(Utils.messageIdentity(undefined)).toBe('');
  });
});

/**
 * Structural guard: an authentication failure must reach the user.
 *
 * On 2026-09-30 the Claude OAuth refresh token expired and every chat on all
 * four instances failed for 26 hours. Nothing was broken in the detection path:
 * `/api/health` reported `authWarning: "OAUTH_REFRESH_TOKEN_EXPIRED"` correctly
 * the whole time, and `scripts/watchdog.ps1` logged it as ERROR every five
 * minutes. Both ends terminated in a log file nobody reads.
 *
 * What the user saw was the CLI's own "Failed to authenticate: OAuth session
 * expired and could not be refreshed" arriving as a command error — no cause, no
 * remedy, and the existing `modal-claude-auth-warning` stayed shut because the
 * CLI still reported itself logged in. The frontend asked for health exactly
 * once, at load, and read only the version out of the response.
 *
 * These assertions pin the three things that made it invisible, so the next
 * occurrence is a banner with an instruction instead of 26 silent hours.
 */
const fs = require('fs');
const path = require('path');

const APP_JS = path.join(__dirname, '..', '..', 'public', 'js', 'app.js');
const INDEX_HTML = path.join(__dirname, '..', '..', 'public', 'index.html');

const app = fs.readFileSync(APP_JS, 'utf8');
const html = fs.readFileSync(INDEX_HTML, 'utf8');

/** Every warning code `/api/health` can report, from src/utils/claude-oauth.ts. */
const WARNING_CODES = [
  'OAUTH_CREDENTIALS_MISSING',
  'OAUTH_CREDENTIALS_UNREADABLE',
  'OAUTH_SESSION_EXPIRED',
  'OAUTH_REFRESH_TOKEN_EXPIRED',
  'OAUTH_REFRESH_TOKEN_EXPIRING',
  'UNUSABLE_ANTHROPIC_API_KEY',
];

describe('an authentication failure is visible in the UI', () => {
  it('the banner the user reads is in the markup, above the composer', () => {
    expect(html).toContain('id="claude-auth-banner"');
    expect(html).toContain('id="claude-auth-banner-title"');
    expect(html).toContain('id="claude-auth-banner-detail"');
    expect(html).toContain('id="claude-auth-banner-action"');

    // Placement is the point: it has to sit where someone looks when a message
    // comes back failed, not in a modal or a corner of the settings screen.
    const bannerAt = html.indexOf('id="claude-auth-banner"');
    const inputAreaAt = html.indexOf('id="interactive-input-area"');
    const composerAt = html.indexOf('id="input-message"');

    expect(inputAreaAt).toBeGreaterThan(-1);
    expect(bannerAt).toBeGreaterThan(inputAreaAt);
    expect(bannerAt).toBeLessThan(composerAt);
  });

  it('the health response is applied, not just read for the version', () => {
    expect(app).toMatch(/applyAuthWarning\s*\(\s*data\s*\)/);
    expect(app).toMatch(/function\s+applyAuthWarning\s*\(/);
  });

  it('health is re-read, because one read at load cannot see a later expiry', () => {
    expect(app).toMatch(/function\s+setupAuthWarningPoll\s*\(/);
    expect(app).toMatch(/setupAuthWarningPoll\s*\(\s*\)\s*;/);
    expect(app).toMatch(/setInterval\s*\(\s*refresh\s*,\s*AUTH_WARNING_POLL_MS\s*\)/);
  });

  it('it also re-reads on wake-up, since a phone freezes background timers', () => {
    const poll = app.slice(app.indexOf('function setupAuthWarningPoll'));

    for (const event of ['visibilitychange', 'focus', 'online', 'pageshow']) {
      expect(poll).toContain(`'${event}'`);
    }
  });

  it('every warning code names its own remedy', () => {
    const remedies = app.slice(
      app.indexOf('function authWarningAction'),
      app.indexOf('function applyAuthWarning')
    );

    expect(remedies.length).toBeGreaterThan(0);

    for (const code of WARNING_CODES) {
      expect(remedies).toContain(code);
    }

    // The remedies differ — re-login, wait, remove an environment variable — so a
    // single shared sentence would send people to the wrong place. Each branch
    // has to carry its own text.
    expect(remedies).toContain('/login');
    expect(remedies).toContain('ANTHROPIC_API_KEY');
  });

  it('a deadline does not render as an outage', () => {
    // OAUTH_REFRESH_TOKEN_EXPIRING fires days early while every chat still
    // works. A banner that says "chats are failing" at that moment spends the
    // credibility the real one depends on, so severity drives the wording.
    const apply = app.slice(app.indexOf('function applyAuthWarning'));
    const body = apply.slice(0, apply.indexOf('\n  }'));

    expect(body).toContain('authWarningSeverity');
    expect(body).toContain('claude-auth-banner-title');
  });

  it('the send toast fires only for a failure, never for a deadline', () => {
    const guard = app.slice(app.indexOf('if (state.authWarning'));
    const body = guard.slice(0, guard.indexOf('}') + 1);

    // Days of a toast on every send is how a user learns to dismiss it.
    expect(body).toContain("state.authWarningSeverity !== 'warning'");
  });

  it('a warning never refuses the send', () => {
    // The composer is never disabled (composer-single-owner.test.js) and a send
    // is never silently dropped, but a *refused* send is just as bad here: the
    // flag comes from a poll that can be a minute stale, and refusing would
    // destroy what the user typed over a condition that may already be fixed.
    const guard = app.slice(app.indexOf('if (state.authWarning'));
    const body = guard.slice(0, guard.indexOf('}') + 1);

    expect(body).toContain('showToast');
    expect(body).not.toContain('return');
  });
});

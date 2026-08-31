import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  describeClaudeOauth,
  defaultCredentialsPath,
  resetClaudeOauthCache,
} from '../../../src/utils/claude-oauth';

/**
 * On 2026-08-31 every chat failed with "OAuth session expired and could not be
 * refreshed" and the cause could not be established: the failure happens inside
 * the Claude CLI, so a full search of that day's logs across four ports produced
 * no auth entry at all. By the time anyone looked, a later refresh had already
 * succeeded and the only evidence left was a file mtime.
 *
 * These tests pin the state that has to be observable from outside the CLI.
 */
describe('describeClaudeOauth', () => {
  let dir: string;
  let file: string;

  const HOUR = 3_600_000;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-oauth-'));
    file = path.join(dir, '.credentials.json');
    resetClaudeOauthCache();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    resetClaudeOauthCache();
  });

  function write(oauth: Record<string, unknown>): void {
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: oauth }), 'utf8');
    // The result is cached against a stat signature, and a test writing twice in
    // the same millisecond would otherwise read the previous parse.
    resetClaudeOauthCache();
  }

  const healthy = () => ({
    accessToken: 'a'.repeat(108),
    refreshToken: 'r'.repeat(108),
    expiresAt: Date.now() + 7 * HOUR,
    refreshTokenExpiresAt: Date.now() + 30 * 24 * HOUR,
    subscriptionType: 'team',
    rateLimitTier: 'default_claude_max_5x',
  });

  it('reports a healthy session with no warning', () => {
    write(healthy());

    const status = describeClaudeOauth(file);

    expect(status.present).toBe(true);
    expect(status.readable).toBe(true);
    expect(status.expired).toBe(false);
    expect(status.problem).toBeNull();
    expect(status.warningCode).toBeNull();
    expect(status.expiresInMinutes).toBeGreaterThan(0);
  });

  it('never returns the tokens', () => {
    write(healthy());

    const serialised = JSON.stringify(describeClaudeOauth(file));

    // The endpoint that carries this is reachable from the LAN and the tailnet.
    expect(serialised).not.toContain('a'.repeat(20));
    expect(serialised).not.toContain('r'.repeat(20));
    expect(serialised).not.toContain('accessToken');
    expect(serialised).not.toContain('refreshToken"');
  });

  it('surfaces the non-secret account facts that make a report actionable', () => {
    write(healthy());

    const status = describeClaudeOauth(file);

    expect(status.subscriptionType).toBe('team');
    expect(status.rateLimitTier).toBe('default_claude_max_5x');
    expect(status.credentialsPath).toBe(file);
  });

  it('flags an access token that is past its expiry — the window chats fail in', () => {
    write({ ...healthy(), expiresAt: Date.now() - 5 * 60_000 });

    const status = describeClaudeOauth(file);

    expect(status.expired).toBe(true);
    expect(status.warningCode).toBe('OAUTH_SESSION_EXPIRED');
    expect(status.expiresInMinutes).toBeLessThan(0);
  });

  it('distinguishes a dead refresh token, which cannot self-heal', () => {
    write({
      ...healthy(),
      expiresAt: Date.now() - 5 * 60_000,
      refreshTokenExpiresAt: Date.now() - HOUR,
    });

    const status = describeClaudeOauth(file);

    // Both are expired here. Reporting OAUTH_SESSION_EXPIRED would tell the
    // operator to wait for a refresh that can never succeed.
    expect(status.warningCode).toBe('OAUTH_REFRESH_TOKEN_EXPIRED');
    expect(status.refreshTokenExpired).toBe(true);
    expect(status.problem).toContain('/login');
  });

  it('reports when a refresh last rewrote the file', () => {
    write(healthy());

    const status = describeClaudeOauth(file);

    // All instances share this one file and refresh tokens rotate on use, so
    // rewrites seconds apart are the fingerprint of two instances colliding.
    expect(status.lastRefreshedAt).not.toBeNull();
    expect(Number.isNaN(Date.parse(status.lastRefreshedAt as string))).toBe(false);
  });

  it('reports a missing file rather than pretending the session is fine', () => {
    const status = describeClaudeOauth(path.join(dir, 'nope.json'));

    expect(status.present).toBe(false);
    expect(status.readable).toBe(false);
    expect(status.warningCode).toBe('OAUTH_CREDENTIALS_MISSING');
  });

  it('reports unreadable content rather than throwing', () => {
    fs.writeFileSync(file, '{ not json', 'utf8');
    resetClaudeOauthCache();

    const status = describeClaudeOauth(file);

    expect(status.present).toBe(true);
    expect(status.readable).toBe(false);
    expect(status.warningCode).toBe('OAUTH_CREDENTIALS_UNREADABLE');
  });

  it('treats a file with no OAuth section as unreadable', () => {
    fs.writeFileSync(file, JSON.stringify({ mcpOAuth: {} }), 'utf8');
    resetClaudeOauthCache();

    expect(describeClaudeOauth(file).warningCode).toBe('OAUTH_CREDENTIALS_UNREADABLE');
  });

  it('accepts a string expiry, which the CLI has written before', () => {
    write({ ...healthy(), expiresAt: String(Date.now() + 7 * HOUR) });

    const status = describeClaudeOauth(file);

    // Rejecting this would report a perfectly healthy session as broken.
    expect(status.readable).toBe(true);
    expect(status.expired).toBe(false);
    expect(status.warningCode).toBeNull();
  });

  it('tolerates a missing expiry without claiming expiry', () => {
    write({ accessToken: 'a', refreshToken: 'r' });

    const status = describeClaudeOauth(file);

    // Unknown is not expired. Guessing either way would produce a false alarm
    // or hide a real outage.
    expect(status.expiresAt).toBeNull();
    expect(status.expired).toBe(false);
    expect(status.warningCode).toBeNull();
  });

  it('recomputes the remaining time even while the file is unchanged', () => {
    write(healthy());

    const first = describeClaudeOauth(file);
    const second = describeClaudeOauth(file);

    // The file parse is cached against a stat signature; the time-derived
    // fields must not be, or "expires in" would be frozen at first read and an
    // expiry would never be noticed.
    expect(first.expiresAt).toBe(second.expiresAt);
    expect(second.expiresInMinutes).not.toBeNull();
  });

  it('notices an expiry that changed on disk', () => {
    write(healthy());
    expect(describeClaudeOauth(file).warningCode).toBeNull();

    write({ ...healthy(), expiresAt: Date.now() - 60_000 });

    expect(describeClaudeOauth(file).warningCode).toBe('OAUTH_SESSION_EXPIRED');
  });

  it('defaults to the Claude CLI credentials path', () => {
    expect(defaultCredentialsPath()).toBe(
      path.join(os.homedir(), '.claude', '.credentials.json')
    );
  });
});

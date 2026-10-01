import {
  createAuthMonitor,
  AuthMonitorDependencies,
  RESEND_INTERVAL_MS,
  SESSION_EXPIRED_GRACE_MS,
} from '../../../src/services/auth-monitor';
import { ClaudeOauthStatus } from '../../../src/utils/claude-oauth';
import { GlobalSettings } from '../../../src/repositories/settings';

const sendEmail = jest.fn();

jest.mock('../../../src/services/email-service', () => ({
  createEmailService: () => ({ sendEmail, testConnection: jest.fn() }),
}));

/**
 * The 2026-09-30 outage lasted 26 hours because the warning never reached a
 * person. These tests pin the two halves of fixing that, which pull in opposite
 * directions: a real problem must always produce a message, and a condition that
 * routinely resolves itself must never produce one.
 *
 * The second half is not a nicety. `OAUTH_SESSION_EXPIRED` appeared overnight on
 * 2026-09-10 and 2026-09-16, cleared on its own both times, and would have sent
 * two false alarms. An alert channel that cries wolf is one nobody reads — which
 * is the failure being fixed, reintroduced from the other side.
 */
describe('createAuthMonitor', () => {
  let clock: number;

  const HOUR = 3_600_000;

  beforeEach(() => {
    sendEmail.mockReset();
    sendEmail.mockResolvedValue(undefined);
    clock = Date.parse('2026-10-01T00:00:00.000Z');
  });

  const emailSettings = {
    enabled: true,
    smtpHost: 'smtp.example.com',
    smtpPort: 587,
    smtpSecure: false,
    smtpUser: 'user',
    smtpPassword: 'secret',
    fromAddress: 'claudito@example.com',
    defaultRecipient: 'operator@example.com',
  };

  function status(over: Partial<ClaudeOauthStatus> = {}): ClaudeOauthStatus {
    return {
      credentialsPath: '/tmp/.credentials.json',
      present: true,
      readable: true,
      expiresAt: null,
      expiresInMinutes: null,
      expired: false,
      refreshTokenExpiresAt: null,
      refreshTokenExpired: false,
      refreshTokenExpiresInDays: null,
      refreshTokenExpiring: false,
      lastRefreshedAt: null,
      subscriptionType: 'team',
      rateLimitTier: null,
      problem: null,
      warningCode: null,
      severity: null,
      ...over,
    };
  }

  function monitorFor(
    next: () => ClaudeOauthStatus,
    settings: Partial<GlobalSettings> = {}
  ): ReturnType<typeof createAuthMonitor> {
    const deps: AuthMonitorDependencies = {
      settingsRepository: {
        get: async () => ({ email: emailSettings, ...settings }) as unknown as GlobalSettings,
      },
      describeOauth: next,
      now: () => clock,
      logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      } as unknown as AuthMonitorDependencies['logger'],
    };

    return createAuthMonitor(deps);
  }

  const expired = () =>
    status({
      warningCode: 'OAUTH_REFRESH_TOKEN_EXPIRED',
      severity: 'failing',
      refreshTokenExpired: true,
      problem: 'Claude OAuth refresh token has expired — sign in again with `claude` → /login',
    });

  const expiring = () =>
    status({
      warningCode: 'OAUTH_REFRESH_TOKEN_EXPIRING',
      severity: 'warning',
      refreshTokenExpiring: true,
      refreshTokenExpiresInDays: 3,
      problem: 'Claude OAuth refresh token expires in 3 days',
    });

  const sessionExpired = () =>
    status({ warningCode: 'OAUTH_SESSION_EXPIRED', severity: 'failing', expired: true });

  it('says nothing while the session is healthy', async () => {
    await monitorFor(() => status()).check();

    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('mails immediately when the refresh token is dead', async () => {
    await monitorFor(expired).check();

    expect(sendEmail).toHaveBeenCalledTimes(1);

    const [to, subject, body] = sendEmail.mock.calls[0] as [string, string, string];

    expect(to).toBe('operator@example.com');
    expect(subject).toContain('인증 실패');
    // The remedy is the entire reason for the mail — the CLI's own error omits it.
    expect(body).toContain('/login');
  });

  it('mails the deadline warning days ahead, and says chats still work', async () => {
    await monitorFor(expiring).check();

    const [, subject, body] = sendEmail.mock.calls[0] as [string, string, string];

    expect(subject).toContain('3일 남음');
    expect(body).toContain('채팅은 아직 정상');
  });

  it('does not mail a session expiry that is still plausibly self-healing', async () => {
    const monitor = monitorFor(sessionExpired);

    await monitor.check();
    clock += SESSION_EXPIRED_GRACE_MS - 60_000;
    await monitor.check();

    // This is the 2026-09-10 / 09-16 overnight shape: expired, nobody using it,
    // refreshed on first use hours later. Two e-mails about nothing would have
    // taught the reader to ignore the channel.
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('mails a session expiry that outlives its grace period', async () => {
    const monitor = monitorFor(sessionExpired);

    await monitor.check();
    clock += SESSION_EXPIRED_GRACE_MS + 60_000;
    await monitor.check();

    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('does not repeat while the same problem persists', async () => {
    const monitor = monitorFor(expired);

    await monitor.check();
    clock += RESEND_INTERVAL_MS - HOUR;
    await monitor.check();

    // 26 hours at the check interval would otherwise be ~104 identical mails.
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('repeats once the resend interval has passed', async () => {
    const monitor = monitorFor(expired);

    await monitor.check();
    clock += RESEND_INTERVAL_MS + HOUR;
    await monitor.check();

    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it('mails again when a warning escalates into a failure', async () => {
    let current = expiring();
    const monitor = monitorFor(() => current);

    await monitor.check();
    current = expired();
    await monitor.check();

    // Not a repeat: the deadline passed and chats are now down. Suppressing this
    // as "same problem" would hide the transition that matters most.
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect((sendEmail.mock.calls[1] as [string, string, string])[1]).toContain('인증 실패');
  });

  it('re-arms after a recovery, so the next outage is reported too', async () => {
    let current = expired();
    const monitor = monitorFor(() => current);

    await monitor.check();
    current = status();
    await monitor.check();
    current = expired();
    await monitor.check();

    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it('retries on the next tick when sending fails', async () => {
    sendEmail.mockRejectedValueOnce(new Error('SMTP unreachable'));

    const monitor = monitorFor(expired);

    await monitor.check();
    await monitor.check();

    // A transient SMTP failure must not consume the only notification there is.
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it('stays quiet, and does not crash, when e-mail is not configured', async () => {
    const monitor = monitorFor(expired, {
      email: { ...emailSettings, enabled: false },
    } as unknown as Partial<GlobalSettings>);

    await expect(monitor.check()).resolves.toBeUndefined();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('survives a credentials read that throws', async () => {
    const monitor = monitorFor(() => {
      throw new Error('unreadable');
    });

    await expect(monitor.check()).resolves.toBeUndefined();
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

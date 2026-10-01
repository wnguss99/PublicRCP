import { GlobalSettings } from '../repositories/settings';
import { createEmailService } from './email-service';
import { getLogger, Logger } from '../utils';
import {
  ClaudeOauthStatus,
  ClaudeOauthWarningCode,
  describeClaudeOauth,
} from '../utils/claude-oauth';

/**
 * Tell a human that Claude authentication is about to fail — or already has.
 *
 * The 2026-09-30 outage was not a detection failure. `/api/health` reported
 * `OAUTH_REFRESH_TOKEN_EXPIRED` correctly for 26 hours and the watchdog logged
 * it every two minutes; both ended in files nobody reads, and the only thing a
 * user ever saw was the CLI's own error with no remedy in it. The UI banner
 * closes that for anyone with claudito open. This closes it for everyone else.
 *
 * It deliberately does not try to repair anything. An expired refresh token can
 * only be replaced by a human running `claude` → `/login`, so the single useful
 * action here is making sure that human finds out — ideally days before the
 * token dies, which `OAUTH_REFRESH_TOKEN_EXPIRING` makes possible.
 *
 * Mail is sent from the instance's own configured account to its own default
 * recipient, so on this host each of the four instances tells its own user.
 */

/** How often the credentials file is examined. */
export const AUTH_CHECK_INTERVAL_MS = 15 * 60_000;

/**
 * How long `OAUTH_SESSION_EXPIRED` has to persist before it is worth an e-mail.
 *
 * This one normally heals itself: when nothing is running, the access token sits
 * expired until the next use refreshes it. On 2026-09-10 and 2026-09-16 exactly
 * that happened overnight — the warning appeared at 00:01 and 01:53 and cleared
 * when work resumed, ~10 and ~16 hours later, with no action taken and none
 * needed. Mailing on sight would have sent two alarms about nothing, and the
 * credibility of the one that mattered three weeks later is the whole asset
 * here. Past this grace period it is no longer plausibly self-healing.
 */
export const SESSION_EXPIRED_GRACE_MS = 2 * 60 * 60_000;

/** Minimum gap between two e-mails about the same unchanged problem. */
export const RESEND_INTERVAL_MS = 12 * 60 * 60_000;

export interface AuthMonitor {
  /** Run one check immediately. Exposed for tests and for the startup check. */
  check(): Promise<void>;
  start(): void;
  stop(): void;
}

/**
 * Only the read is needed, so only the read is required.
 *
 * The two settings repositories in this codebase disagree on what `update()`
 * returns, and depending on the full interface would force a cast here for a
 * method this service never calls.
 */
export interface SettingsReader {
  get(): Promise<GlobalSettings>;
}

export interface AuthMonitorDependencies {
  settingsRepository: SettingsReader;
  logger?: Logger;
  /** Injectable for tests; defaults to the real credentials file. */
  describeOauth?: () => ClaudeOauthStatus;
  now?: () => number;
}

interface AlertState {
  code: ClaudeOauthWarningCode;
  /** When this code was first seen in an unbroken run. */
  firstSeenAt: number;
  /** When an e-mail about this code last went out, or null if none has. */
  lastNotifiedAt: number | null;
}

function subjectFor(status: ClaudeOauthStatus): string {
  if (status.warningCode === 'OAUTH_REFRESH_TOKEN_EXPIRING') {
    return `[claudito] Claude 재로그인 필요 — ${status.refreshTokenExpiresInDays}일 남음`;
  }

  return '[claudito] Claude 인증 실패 — 모든 채팅이 동작하지 않습니다';
}

function bodyFor(status: ClaudeOauthStatus, port: number | null): string {
  const lines = [
    status.problem ?? status.warningCode ?? '',
    '',
    `- 코드: ${status.warningCode}`,
    `- 심각도: ${status.severity === 'warning' ? '예고 (채팅은 아직 정상)' : '장애 (채팅 전부 실패)'}`,
  ];

  if (port !== null) {
    lines.push(`- 인스턴스: 포트 ${port}`);
  }

  if (status.refreshTokenExpiresAt !== null) {
    lines.push(`- refresh token 만료: ${status.refreshTokenExpiresAt} (${status.refreshTokenExpiresInDays}일)`);
  }

  if (status.lastRefreshedAt !== null) {
    lines.push(`- 마지막 갱신: ${status.lastRefreshedAt}`);
  }

  lines.push(
    '',
    '조치: 호스트 터미널에서 `claude` 를 실행하고 `/login` 으로 다시 로그인하세요.',
    '자격증명 파일은 네 인스턴스가 공유하므로 한 번만 하면 됩니다.'
  );

  return lines.join('\n');
}

export function createAuthMonitor(deps: AuthMonitorDependencies): AuthMonitor {
  const logger = deps.logger ?? getLogger('auth-monitor');
  const describe = deps.describeOauth ?? (() => describeClaudeOauth());
  const now = deps.now ?? (() => Date.now());

  let timer: NodeJS.Timeout | null = null;
  let state: AlertState | null = null;

  /**
   * Whether this observation deserves an e-mail right now.
   *
   * Three things gate it, and each one exists because of a real failure mode:
   * a self-healing code must survive its grace period (2026-09-10/16 would
   * otherwise have cried wolf), an unchanged problem must not repeat faster than
   * the resend interval (26 hours at the check interval is 104 mails), and a
   * code that *changes* always sends — `EXPIRING` becoming `EXPIRED` is an
   * escalation, not a repeat.
   */
  function shouldNotify(current: AlertState, status: ClaudeOauthStatus): boolean {
    if (status.warningCode === 'OAUTH_SESSION_EXPIRED') {
      if (now() - current.firstSeenAt < SESSION_EXPIRED_GRACE_MS) {
        return false;
      }
    }

    if (current.lastNotifiedAt === null) {
      return true;
    }

    return now() - current.lastNotifiedAt >= RESEND_INTERVAL_MS;
  }

  async function notify(status: ClaudeOauthStatus): Promise<boolean> {
    const settings = await deps.settingsRepository.get();
    const email = settings.email;

    if (!email?.enabled || !email.smtpHost || !email.smtpUser || !email.smtpPassword) {
      // Not an error: most instances may never configure mail. The banner and
      // the watchdog log still carry the warning, so say so once and move on.
      logger.warn('Claude auth warning not mailed — e-mail is not configured on this instance', {
        warningCode: status.warningCode,
      });
      return false;
    }

    const to = email.defaultRecipient;

    if (!to) {
      logger.warn('Claude auth warning not mailed — no default recipient configured', {
        warningCode: status.warningCode,
      });
      return false;
    }

    const port = Number(process.env['PORT']) || null;

    await createEmailService(email).sendEmail(to, subjectFor(status), bodyFor(status, port));
    logger.info('Claude auth warning mailed', { warningCode: status.warningCode, to });
    return true;
  }

  async function check(): Promise<void> {
    let status: ClaudeOauthStatus;

    try {
      status = describe();
    } catch (error) {
      logger.error('Claude auth check failed', { error });
      return;
    }

    if (status.warningCode === null) {
      if (state !== null) {
        logger.info('Claude auth recovered', { previousCode: state.code });
        state = null;
      }
      return;
    }

    // A different code is a different problem — reset the run so its own grace
    // period and resend interval apply from here.
    if (state === null || state.code !== status.warningCode) {
      state = { code: status.warningCode, firstSeenAt: now(), lastNotifiedAt: null };
      logger.warn('Claude auth warning', { warningCode: status.warningCode, problem: status.problem });
    }

    if (!shouldNotify(state, status)) {
      return;
    }

    try {
      if (await notify(status)) {
        state.lastNotifiedAt = now();
      } else {
        // Mail is unavailable rather than failing. Record the attempt so an
        // unconfigured instance does not log the same line every interval.
        state.lastNotifiedAt = now();
      }
    } catch (error) {
      // Leave lastNotifiedAt alone so the next tick retries: a transient SMTP
      // failure must not swallow the only notification of a 26-hour outage.
      logger.error('Failed to mail Claude auth warning', { error, warningCode: status.warningCode });
    }
  }

  return {
    check,
    start(): void {
      if (timer !== null) return;

      timer = setInterval(() => void check(), AUTH_CHECK_INTERVAL_MS);
      // Housekeeping must never be the reason the process refuses to exit — the
      // shutdown path already has to fight a wedged CLI for its 15 seconds.
      timer.unref();
    },
    stop(): void {
      if (timer === null) return;

      clearInterval(timer);
      timer = null;
    },
  };
}

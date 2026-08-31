import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * The state of the Claude CLI's OAuth session, without ever exposing a token.
 *
 * On 2026-08-31 every chat failed with "Failed to authenticate: OAuth session
 * expired and could not be refreshed", and the cause could not be established
 * afterwards: the failure happens inside the CLI, so claudito logged nothing at
 * all. A full search of that day's logs across four ports produced zero auth
 * entries. By the time anyone looked, a later refresh had succeeded and the only
 * evidence left was a file mtime.
 *
 * The window where chats fail is exactly the window where the stored access
 * token is past `expiresAt` and no refresh has replaced it. That is observable
 * from outside the CLI, which is what this reports — so the next occurrence has
 * a timestamp and a duration instead of a guess.
 *
 * `lastRefreshedAt` matters as much as the expiry. All instances share this one
 * file and OAuth refresh tokens rotate on use, so two instances refreshing at
 * once means one of them is left holding a token that has already been revoked.
 * Successive rewrites seconds apart are the fingerprint of that collision.
 */
export interface ClaudeOauthStatus {
  /** Where we looked. Reported so an operator can check the same file. */
  credentialsPath: string;
  present: boolean;
  /** False when the file exists but could not be read or parsed. */
  readable: boolean;
  expiresAt: string | null;
  /** Negative once the access token is past its expiry. */
  expiresInMinutes: number | null;
  expired: boolean;
  refreshTokenExpiresAt: string | null;
  refreshTokenExpired: boolean;
  /** File mtime — when a refresh last rewrote the credentials. */
  lastRefreshedAt: string | null;
  subscriptionType: string | null;
  rateLimitTier: string | null;
  /** One-sentence reason chats would be failing, or null when healthy. */
  problem: string | null;
  /** Stable code for /api/health and the watchdog, or null when healthy. */
  warningCode: ClaudeOauthWarningCode | null;
}

export type ClaudeOauthWarningCode =
  | 'OAUTH_CREDENTIALS_MISSING'
  | 'OAUTH_CREDENTIALS_UNREADABLE'
  | 'OAUTH_SESSION_EXPIRED'
  | 'OAUTH_REFRESH_TOKEN_EXPIRED';

interface RawOauth {
  expiresAt?: unknown;
  refreshTokenExpiresAt?: unknown;
  subscriptionType?: unknown;
  rateLimitTier?: unknown;
}

/** Parsed file content, cached until the file changes on disk. */
interface CachedFile {
  signature: string;
  oauth: RawOauth | null;
  mtimeMs: number;
}

let cache: CachedFile | null = null;

export function defaultCredentialsPath(): string {
  return path.join(os.homedir(), '.claude', '.credentials.json');
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  // The CLI has written this as a string before now, so accept both rather than
  // reporting a healthy session as unreadable.
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function toIso(epochMs: number | null): string | null {
  if (epochMs === null) {
    return null;
  }

  const date = new Date(epochMs);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Read the credentials file, reusing the previous parse while it is unchanged.
 *
 * /api/health is polled by the browser and by the watchdog on every instance, so
 * this is guarded by a stat signature rather than re-reading and re-parsing each
 * time. Time-derived fields are always recomputed by the caller — caching those
 * would report a stale "expires in" forever.
 */
function loadFile(credentialsPath: string): CachedFile {
  let stat: fs.Stats;

  try {
    stat = fs.statSync(credentialsPath);
  } catch {
    cache = null;
    return { signature: 'missing', oauth: null, mtimeMs: 0 };
  }

  const signature = `${stat.size}:${stat.mtimeMs}`;

  if (cache !== null && cache.signature === signature) {
    return cache;
  }

  let oauth: RawOauth | null = null;

  try {
    const parsed = JSON.parse(fs.readFileSync(credentialsPath, 'utf8')) as {
      claudeAiOauth?: RawOauth;
    };
    oauth = parsed.claudeAiOauth ?? null;
  } catch {
    oauth = null;
  }

  cache = { signature, oauth, mtimeMs: stat.mtimeMs };
  return cache;
}

/** Reset the file cache. Exported for tests, which write the file repeatedly. */
export function resetClaudeOauthCache(): void {
  cache = null;
}

export function describeClaudeOauth(credentialsPath?: string): ClaudeOauthStatus {
  const filePath = credentialsPath ?? defaultCredentialsPath();
  const file = loadFile(filePath);

  const base = {
    credentialsPath: filePath,
    expiresAt: null,
    expiresInMinutes: null,
    expired: false,
    refreshTokenExpiresAt: null,
    refreshTokenExpired: false,
    lastRefreshedAt: null,
    subscriptionType: null,
    rateLimitTier: null,
  };

  if (file.signature === 'missing') {
    return {
      ...base,
      present: false,
      readable: false,
      problem: 'Claude CLI credentials file not found — run `claude` and sign in',
      warningCode: 'OAUTH_CREDENTIALS_MISSING',
    };
  }

  const lastRefreshedAt = toIso(file.mtimeMs);

  if (file.oauth === null) {
    return {
      ...base,
      present: true,
      readable: false,
      lastRefreshedAt,
      problem: 'Claude CLI credentials file is unreadable or has no OAuth section',
      warningCode: 'OAUTH_CREDENTIALS_UNREADABLE',
    };
  }

  const expiresAtMs = readNumber(file.oauth.expiresAt);
  const refreshExpiresAtMs = readNumber(file.oauth.refreshTokenExpiresAt);
  const now = Date.now();

  const expiresInMinutes =
    expiresAtMs === null ? null : Math.round(((expiresAtMs - now) / 60_000) * 10) / 10;
  const expired = expiresAtMs !== null && expiresAtMs <= now;
  const refreshTokenExpired = refreshExpiresAtMs !== null && refreshExpiresAtMs <= now;

  const detail = {
    credentialsPath: filePath,
    present: true,
    readable: true,
    expiresAt: toIso(expiresAtMs),
    expiresInMinutes,
    expired,
    refreshTokenExpiresAt: toIso(refreshExpiresAtMs),
    refreshTokenExpired,
    lastRefreshedAt,
    subscriptionType: readString(file.oauth.subscriptionType),
    rateLimitTier: readString(file.oauth.rateLimitTier),
  };

  // Reported first: a dead refresh token cannot recover on its own, while an
  // expired access token normally does. Conflating them would send an operator
  // to wait out a problem that only a fresh sign-in fixes.
  if (refreshTokenExpired) {
    return {
      ...detail,
      problem: 'Claude OAuth refresh token has expired — sign in again with `claude` → /login',
      warningCode: 'OAUTH_REFRESH_TOKEN_EXPIRED',
    };
  }

  if (expired) {
    return {
      ...detail,
      problem:
        'Claude OAuth access token is past its expiry and has not been refreshed — ' +
        'chats fail until a refresh succeeds',
      warningCode: 'OAUTH_SESSION_EXPIRED',
    };
  }

  return { ...detail, problem: null, warningCode: null };
}

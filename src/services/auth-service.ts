/**
 * Authentication Service
 * Handles credential generation and session management
 */

import { randomBytes, createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { generateRandomUsername } from '../utils/word-lists';
import { getDataDirectory } from '../utils/paths';

export interface Credentials {
  username: string;
  password: string;
}

export interface Session {
  id: string;
  createdAt: number;
  expiresAt: number;
}

export interface AuthService {
  getCredentials(): Credentials;
  createSession(): Session;
  validateSession(sessionId: string): boolean;
  invalidateSession(sessionId: string): void;
}

const PASSWORD_LENGTH = 16;
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Character sets for password generation
const LOWERCASE = 'abcdefghijkmnopqrstuvwxyz';
const UPPERCASE = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const NUMBERS = '23456789';
const SYMBOLS = '!@#$%&*';

/**
 * Generate a strong random password with all character classes
 */
function generatePassword(length: number = PASSWORD_LENGTH): string {
  const allChars = LOWERCASE + UPPERCASE + NUMBERS + SYMBOLS;
  const bytes = randomBytes(length + 10); // Extra bytes for selection

  // Ensure at least one char from each class
  const required = [
    LOWERCASE.charAt(bytes[0]! % LOWERCASE.length),
    UPPERCASE.charAt(bytes[1]! % UPPERCASE.length),
    NUMBERS.charAt(bytes[2]! % NUMBERS.length),
    SYMBOLS.charAt(bytes[3]! % SYMBOLS.length)
  ];

  // Fill remaining with random from all chars
  const remaining: string[] = [];

  for (let i = 4; i < length; i++) {
    remaining.push(allChars.charAt(bytes[i]! % allChars.length));
  }

  // Combine and shuffle using Fisher-Yates
  const combined = [...required, ...remaining];

  for (let i = combined.length - 1; i > 0; i--) {
    const j = bytes[i + 4]! % (i + 1);
    [combined[i], combined[j]] = [combined[j]!, combined[i]!];
  }

  return combined.join('');
}

/**
 * Get credentials from environment variables or generate new ones
 * If CLAUDITO_USERNAME and CLAUDITO_PASSWORD are set, use those
 */
function getOrGenerateCredentials(): Credentials {
  const envUsername = process.env.CLAUDITO_USERNAME;
  const envPassword = process.env.CLAUDITO_PASSWORD;

  if (envUsername && envPassword) {
    return { username: envUsername, password: envPassword };
  }

  return {
    username: generateRandomUsername(),
    password: generatePassword()
  };
}

interface SessionStore {
  load(): PersistedSessions | null;
  save(data: PersistedSessions): void;
}

interface PersistedSessions {
  /** Ties the file to the credentials in force — see below. */
  credentialFingerprint: string;
  sessions: Session[];
}

function fingerprintCredentials(credentials: Credentials): string {
  return createHash('sha256')
    .update(`${credentials.username}\u0000${credentials.password}`)
    .digest('hex');
}

/**
 * Sessions survive a restart by living in {CLAUDITO_HOME}/sessions.json.
 *
 * They used to be memory-only, so every deploy — and every automatic recovery
 * by the watchdog — silently logged out every user on every instance. The file
 * is per instance because CLAUDITO_HOME is, and the session cookie name carries
 * the port, so nothing crosses between instances.
 */
function createFileSessionStore(): SessionStore {
  const filePath = path.join(getDataDirectory(), 'sessions.json');

  return {
    load(): PersistedSessions | null {
      try {
        if (!fs.existsSync(filePath)) {
          return null;
        }

        return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as PersistedSessions;
      } catch {
        // Keep the unreadable file instead of letting the next save overwrite
        // it, matching settings.json and projects/index.json. Losing sessions
        // only costs a re-login, but silently destroying the evidence hides
        // why everyone was logged out.
        try {
          fs.renameSync(filePath, `${filePath}.corrupt`);
        } catch {
          // Best effort — the re-login happens either way.
        }

        return null;
      }
    },
    save(data: PersistedSessions): void {
      try {
        // Atomic: a truncated sessions.json fails to parse and logs every user of
        // this instance out.
        const tempPath = `${filePath}.tmp`;
        fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8');
        fs.renameSync(tempPath, filePath);
      } catch {
        // Persistence is best-effort: losing it only costs a re-login.
      }
    },
  };
}

/**
 * Default implementation of AuthService
 * Uses CLAUDITO_USERNAME/CLAUDITO_PASSWORD env vars if set,
 * otherwise regenerates credentials on each instantiation (server restart)
 * Sessions are persisted per instance so restarts do not log everyone out.
 */
export class DefaultAuthService implements AuthService {
  private credentials: Credentials;
  private sessions: Map<string, Session> = new Map();
  private readonly store: SessionStore | null;
  private readonly fingerprint: string;

  constructor(store: SessionStore | null = createFileSessionStore()) {
    this.credentials = getOrGenerateCredentials();
    this.fingerprint = fingerprintCredentials(this.credentials);
    this.store = store;
    this.restoreSessions();
  }

  private restoreSessions(): void {
    const data = this.store?.load();

    if (!data || !Array.isArray(data.sessions)) {
      return;
    }

    // Rotating a password (or a generated credential changing on restart) must
    // end the sessions it issued — otherwise replacing a leaked password would
    // leave the attacker's cookie working for the rest of its 7 days.
    if (data.credentialFingerprint !== this.fingerprint) {
      return;
    }

    const now = Date.now();

    for (const session of data.sessions) {
      if (session && typeof session.id === 'string' && session.expiresAt > now) {
        this.sessions.set(session.id, session);
      }
    }
  }

  private persistSessions(): void {
    if (!this.store) {
      return;
    }

    // Drop anything expired while we are writing anyway, so the file cannot grow
    // without bound.
    const now = Date.now();

    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.sessions.delete(id);
      }
    }

    this.store.save({
      credentialFingerprint: this.fingerprint,
      sessions: Array.from(this.sessions.values()),
    });
  }

  getCredentials(): Credentials {
    return { ...this.credentials };
  }

  createSession(): Session {
    const now = Date.now();
    const session: Session = {
      id: randomBytes(32).toString('hex'),
      createdAt: now,
      expiresAt: now + SESSION_DURATION_MS
    };

    this.sessions.set(session.id, session);
    this.persistSessions();
    return session;
  }

  validateSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);

    if (!session) {
      return false;
    }

    if (Date.now() > session.expiresAt) {
      this.sessions.delete(sessionId);
      this.persistSessions();
      return false;
    }

    return true;
  }

  invalidateSession(sessionId: string): void {
    if (this.sessions.delete(sessionId)) {
      this.persistSessions();
    }
  }
}

/**
 * Create the default auth service instance
 */
export function createAuthService(): AuthService {
  return new DefaultAuthService();
}

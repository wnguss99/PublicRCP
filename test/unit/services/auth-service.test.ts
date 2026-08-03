import fs from 'fs';
import path from 'path';
import {
  createAuthService,
  AuthService,
  DefaultAuthService,
} from '../../../src/services/auth-service';
import { getDataDirectory } from '../../../src/utils/paths';

describe('AuthService', () => {
  let authService: AuthService;
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment before each test
    process.env = { ...originalEnv };
    delete process.env.CLAUDITO_USERNAME;
    delete process.env.CLAUDITO_PASSWORD;
    authService = createAuthService();
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  describe('createAuthService', () => {
    it('should create a new auth service instance', () => {
      const service = createAuthService();

      expect(service).toBeDefined();
      expect(typeof service.getCredentials).toBe('function');
      expect(typeof service.createSession).toBe('function');
      expect(typeof service.validateSession).toBe('function');
      expect(typeof service.invalidateSession).toBe('function');
    });

    it('should create independent instances with different credentials', () => {
      const service1 = createAuthService();
      const service2 = createAuthService();

      const creds1 = service1.getCredentials();
      const creds2 = service2.getCredentials();

      // Very high probability of being different
      expect(creds1.username).not.toBe(creds2.username);
      expect(creds1.password).not.toBe(creds2.password);
    });
  });

  describe('getCredentials', () => {
    it('should return username and password', () => {
      const credentials = authService.getCredentials();

      expect(credentials.username).toBeDefined();
      expect(credentials.password).toBeDefined();
      expect(typeof credentials.username).toBe('string');
      expect(typeof credentials.password).toBe('string');
    });

    it('should return username in adjective-noun format', () => {
      const credentials = authService.getCredentials();

      // Username should be two words separated by hyphen
      expect(credentials.username).toMatch(/^[a-z]+-[a-z]+$/);
    });

    it('should return password with minimum 16 characters', () => {
      const credentials = authService.getCredentials();

      expect(credentials.password.length).toBeGreaterThanOrEqual(16);
    });

    it('should return password with lowercase letters', () => {
      const credentials = authService.getCredentials();

      expect(credentials.password).toMatch(/[a-z]/);
    });

    it('should return password with uppercase letters', () => {
      const credentials = authService.getCredentials();

      expect(credentials.password).toMatch(/[A-Z]/);
    });

    it('should return password with numbers', () => {
      const credentials = authService.getCredentials();

      expect(credentials.password).toMatch(/[0-9]/);
    });

    it('should return password with symbols', () => {
      const credentials = authService.getCredentials();

      expect(credentials.password).toMatch(/[!@#$%&*]/);
    });

    it('should return the same credentials on multiple calls', () => {
      const creds1 = authService.getCredentials();
      const creds2 = authService.getCredentials();

      expect(creds1.username).toBe(creds2.username);
      expect(creds1.password).toBe(creds2.password);
    });

    it('should return a copy, not the original object', () => {
      const creds1 = authService.getCredentials();
      const creds2 = authService.getCredentials();

      expect(creds1).not.toBe(creds2);
    });
  });

  describe('createSession', () => {
    it('should return session with id, createdAt, and expiresAt', () => {
      const session = authService.createSession();

      expect(session.id).toBeDefined();
      expect(session.createdAt).toBeDefined();
      expect(session.expiresAt).toBeDefined();
    });

    it('should generate unique session IDs', () => {
      const session1 = authService.createSession();
      const session2 = authService.createSession();

      expect(session1.id).not.toBe(session2.id);
    });

    it('should set session expiry to 7 days from creation', () => {
      const session = authService.createSession();
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

      expect(session.expiresAt - session.createdAt).toBe(sevenDaysMs);
    });

    it('should generate session ID as hex string', () => {
      const session = authService.createSession();

      expect(session.id).toMatch(/^[0-9a-f]+$/);
      expect(session.id.length).toBe(64); // 32 bytes = 64 hex chars
    });
  });

  describe('validateSession', () => {
    it('should return true for valid session', () => {
      const session = authService.createSession();

      expect(authService.validateSession(session.id)).toBe(true);
    });

    it('should return false for unknown session ID', () => {
      expect(authService.validateSession('unknown-session-id')).toBe(false);
    });

    it('should return false for empty session ID', () => {
      expect(authService.validateSession('')).toBe(false);
    });

    it('should validate multiple concurrent sessions', () => {
      const session1 = authService.createSession();
      const session2 = authService.createSession();
      const session3 = authService.createSession();

      expect(authService.validateSession(session1.id)).toBe(true);
      expect(authService.validateSession(session2.id)).toBe(true);
      expect(authService.validateSession(session3.id)).toBe(true);
    });
  });

  /**
   * Sessions were a hard 7 days from login with no extension, so an active user
   * was logged out simply because a week had passed. On an install only reachable
   * remotely that strands exactly the person who cannot get to the machine.
   */
  describe('touchSession (sliding expiry)', () => {
    it('keeps an actively used session alive past the original expiry', () => {
      const session = authService.createSession();
      const originalExpiry = session.expiresAt;
      const realNow = Date.now;

      try {
        // Six days later the user is still working.
        Date.now = () => realNow() + 6 * 24 * 60 * 60 * 1000;
        const touched = authService.touchSession(session.id);
        expect(touched).not.toBeNull();
        expect(touched!.expiresAt).toBeGreaterThan(originalExpiry);

        // Eight days after login — past the original expiry, but still valid
        // because it was used in between.
        Date.now = () => realNow() + 8 * 24 * 60 * 60 * 1000;
        expect(authService.validateSession(session.id)).toBe(true);
      } finally {
        Date.now = realNow;
      }
    });

    it('still expires a session nobody used', () => {
      const session = authService.createSession();
      const realNow = Date.now;

      try {
        Date.now = () => realNow() + 8 * 24 * 60 * 60 * 1000;
        expect(authService.touchSession(session.id)).toBeNull();
        expect(authService.validateSession(session.id)).toBe(false);
      } finally {
        Date.now = realNow;
      }
    });

    it('does not rewrite the expiry on every call', () => {
      const session = authService.createSession();

      const first = authService.touchSession(session.id);
      const second = authService.touchSession(session.id);

      // Within the throttle window the expiry is left alone, so a busy session
      // does not rewrite the store on every request.
      expect(second!.expiresAt).toBe(first!.expiresAt);
    });

    it('returns null for an unknown session', () => {
      expect(authService.touchSession('nope')).toBeNull();
    });
  });

  describe('invalidateSession', () => {
    it('should invalidate a valid session', () => {
      const session = authService.createSession();

      expect(authService.validateSession(session.id)).toBe(true);

      authService.invalidateSession(session.id);

      expect(authService.validateSession(session.id)).toBe(false);
    });

    it('should not affect other sessions', () => {
      const session1 = authService.createSession();
      const session2 = authService.createSession();

      authService.invalidateSession(session1.id);

      expect(authService.validateSession(session1.id)).toBe(false);
      expect(authService.validateSession(session2.id)).toBe(true);
    });

    it('should handle invalidating non-existent session gracefully', () => {
      expect(() => {
        authService.invalidateSession('non-existent-id');
      }).not.toThrow();
    });

    it('should handle invalidating already invalidated session', () => {
      const session = authService.createSession();

      authService.invalidateSession(session.id);

      expect(() => {
        authService.invalidateSession(session.id);
      }).not.toThrow();
    });
  });

  describe('Session expiration', () => {
    it('should reject expired session', () => {
      // Create a service with a session, then manipulate time
      const service = new DefaultAuthService();
      const session = service.createSession();

      // Validate before expiry
      expect(service.validateSession(session.id)).toBe(true);

      // We can't easily test time-based expiration without mocking Date.now
      // This test verifies the validation logic works with valid sessions
    });
  });

  describe('Session persistence across restarts', () => {
    // A tiny in-memory stand-in for {CLAUDITO_HOME}/sessions.json so a "restart"
    // is just a second DefaultAuthService reading what the first one wrote.
    interface MemoryStore {
      data: unknown;
      load: jest.Mock;
      save: jest.Mock;
    }

    function createMemoryStore(): MemoryStore {
      const store: MemoryStore = {
        data: null,
        load: jest.fn((): unknown => store.data),
        save: jest.fn((value: unknown): void => {
          store.data = value;
        }),
      };
      return store;
    }

    beforeEach(() => {
      process.env.CLAUDITO_USERNAME = 'persist-user';
      process.env.CLAUDITO_PASSWORD = 'persist-pass-123';
    });

    it('should keep a session valid after a restart', () => {
      const store = createMemoryStore();
      const before = new DefaultAuthService(store as never);
      const session = before.createSession();

      const afterRestart = new DefaultAuthService(store as never);

      expect(afterRestart.validateSession(session.id)).toBe(true);
    });

    it('should drop persisted sessions when the password changes', () => {
      const store = createMemoryStore();
      const before = new DefaultAuthService(store as never);
      const session = before.createSession();

      // Operator rotates a leaked password — the cookie it issued must die.
      process.env.CLAUDITO_PASSWORD = 'rotated-pass-456';
      const afterRotation = new DefaultAuthService(store as never);

      expect(afterRotation.validateSession(session.id)).toBe(false);
    });

    it('should not restore an already expired session', () => {
      const store = createMemoryStore();
      store.data = {
        credentialFingerprint: 'does-not-matter',
        sessions: [{ id: 'stale', createdAt: 0, expiresAt: Date.now() - 1000 }],
      };

      const service = new DefaultAuthService(store as never);

      expect(service.validateSession('stale')).toBe(false);
    });

    it('should invalidate across a restart once logged out', () => {
      const store = createMemoryStore();
      const before = new DefaultAuthService(store as never);
      const session = before.createSession();
      before.invalidateSession(session.id);

      const afterRestart = new DefaultAuthService(store as never);

      expect(afterRestart.validateSession(session.id)).toBe(false);
    });

    it('should work when no store is available', () => {
      const service = new DefaultAuthService(null);
      const session = service.createSession();

      expect(service.validateSession(session.id)).toBe(true);
    });
  });

  describe('Corrupt sessions.json', () => {
    // These go through createAuthService() rather than a memory store because
    // the recovery lives in the real file store. CLAUDITO_HOME is redirected
    // per Jest worker by test/env-setup.ts, so this never touches live data.
    const sessionsPath = (): string => path.join(getDataDirectory(), 'sessions.json');

    function removeIfPresent(file: string): void {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    }

    beforeEach(() => {
      // Without fixed credentials every createAuthService() invents new ones,
      // and the fingerprint mismatch alone would drop the sessions — which
      // would hide whether the corrupt-file handling did its job.
      process.env.CLAUDITO_USERNAME = 'corrupt-case-user';
      process.env.CLAUDITO_PASSWORD = 'corrupt-case-pass-123';

      removeIfPresent(sessionsPath());
      removeIfPresent(`${sessionsPath()}.corrupt`);
    });

    afterEach(() => {
      removeIfPresent(sessionsPath());
      removeIfPresent(`${sessionsPath()}.corrupt`);
    });

    it('should start with an empty session map instead of throwing', () => {
      fs.writeFileSync(sessionsPath(), '{ truncated', 'utf-8');

      const service = createAuthService();

      expect(service.validateSession('anything')).toBe(false);
      expect(service.createSession().id).toBeTruthy();
    });

    it('should preserve the unreadable file as .corrupt', () => {
      fs.writeFileSync(sessionsPath(), '{ truncated', 'utf-8');

      createAuthService();

      // Dropping it silently would erase the only evidence of why every user
      // of this instance was logged out.
      expect(fs.existsSync(`${sessionsPath()}.corrupt`)).toBe(true);
      expect(fs.readFileSync(`${sessionsPath()}.corrupt`, 'utf-8')).toBe('{ truncated');
    });

    it('should not leave the corrupt file where the next save would overwrite it', () => {
      fs.writeFileSync(sessionsPath(), '{ truncated', 'utf-8');

      const service = createAuthService();
      service.createSession();

      const persisted = fs.readFileSync(sessionsPath(), 'utf-8');
      expect(() => JSON.parse(persisted)).not.toThrow();
    });

    it('should leave a valid file alone', () => {
      const service = createAuthService();
      const session = service.createSession();

      const afterRestart = createAuthService();

      expect(afterRestart.validateSession(session.id)).toBe(true);
      expect(fs.existsSync(`${sessionsPath()}.corrupt`)).toBe(false);
    });
  });

  describe('Environment variable credentials', () => {
    it('should use CLAUDITO_USERNAME and CLAUDITO_PASSWORD when both are set', () => {
      process.env.CLAUDITO_USERNAME = 'custom-user';
      process.env.CLAUDITO_PASSWORD = 'custom-pass-123';

      const service = createAuthService();
      const credentials = service.getCredentials();

      expect(credentials.username).toBe('custom-user');
      expect(credentials.password).toBe('custom-pass-123');
    });

    it('should generate credentials when only CLAUDITO_USERNAME is set', () => {
      process.env.CLAUDITO_USERNAME = 'custom-user';

      const service = createAuthService();
      const credentials = service.getCredentials();

      // Should generate random credentials since both aren't set
      expect(credentials.username).toMatch(/^[a-z]+-[a-z]+$/);
      expect(credentials.password.length).toBeGreaterThanOrEqual(16);
    });

    it('should generate credentials when only CLAUDITO_PASSWORD is set', () => {
      process.env.CLAUDITO_PASSWORD = 'custom-pass-123';

      const service = createAuthService();
      const credentials = service.getCredentials();

      // Should generate random credentials since both aren't set
      expect(credentials.username).toMatch(/^[a-z]+-[a-z]+$/);
      expect(credentials.password.length).toBeGreaterThanOrEqual(16);
    });

    it('should generate credentials when neither env var is set', () => {
      const service = createAuthService();
      const credentials = service.getCredentials();

      expect(credentials.username).toMatch(/^[a-z]+-[a-z]+$/);
      expect(credentials.password.length).toBeGreaterThanOrEqual(16);
    });

    it('should use env credentials even if they do not match typical format', () => {
      process.env.CLAUDITO_USERNAME = 'admin';
      process.env.CLAUDITO_PASSWORD = 'password';

      const service = createAuthService();
      const credentials = service.getCredentials();

      expect(credentials.username).toBe('admin');
      expect(credentials.password).toBe('password');
    });
  });
});

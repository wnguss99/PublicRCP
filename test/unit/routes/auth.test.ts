import request from 'supertest';
import express from 'express';
import { createAuthRouter, AuthRouterDependencies } from '../../../src/routes/auth';
import { AuthService } from '../../../src/services/auth-service';
import { COOKIE_NAME } from '../../../src/middleware/auth-middleware';

describe('Auth Routes', () => {
  let app: express.Application;
  let mockAuthService: jest.Mocked<AuthService>;

  const mockCredentials = {
    username: 'testuser',
    password: 'testpass'
  };

  const mockSession = {
    id: 'session-123',
    createdAt: Date.now(),
    expiresAt: Date.now() + 60000 // 1 minute
  };

  beforeEach(() => {
    mockAuthService = {
      getCredentials: jest.fn(),
      createSession: jest.fn(),
      validateSession: jest.fn(),
      touchSession: jest.fn(),
      invalidateSession: jest.fn()
    };

    const deps: AuthRouterDependencies = {
      authService: mockAuthService
    };

    app = express();
    app.use(express.json());
    app.use('/api/auth', createAuthRouter(deps));
  });

  describe('POST /api/auth/login', () => {
    beforeEach(() => {
      mockAuthService.getCredentials.mockReturnValue(mockCredentials);
      mockAuthService.createSession.mockReturnValue(mockSession);
    });

    it('should return 400 when username is missing', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({ password: 'testpass' });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Username and password required' });
      expect(mockAuthService.createSession).not.toHaveBeenCalled();
    });

    it('should return 400 when password is missing', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({ username: 'testuser' });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Username and password required' });
      expect(mockAuthService.createSession).not.toHaveBeenCalled();
    });

    it('should return 400 when both username and password are missing', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Username and password required' });
      expect(mockAuthService.createSession).not.toHaveBeenCalled();
    });

    it('should return 401 when username is incorrect', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({ username: 'wronguser', password: 'testpass' });

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'Invalid credentials' });
      expect(mockAuthService.getCredentials).toHaveBeenCalled();
      expect(mockAuthService.createSession).not.toHaveBeenCalled();
    });

    it('should return 401 when password is incorrect', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({ username: 'testuser', password: 'wrongpass' });

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'Invalid credentials' });
      expect(mockAuthService.getCredentials).toHaveBeenCalled();
      expect(mockAuthService.createSession).not.toHaveBeenCalled();
    });

    it('should login successfully with correct credentials', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({ username: 'testuser', password: 'testpass' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true });
      expect(mockAuthService.getCredentials).toHaveBeenCalled();
      expect(mockAuthService.createSession).toHaveBeenCalled();
    });

    it('should set session cookie on successful login', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({ username: 'testuser', password: 'testpass' });

      expect(response.status).toBe(200);

      const cookies = response.headers['set-cookie'];
      expect(cookies).toBeDefined();

      const sessionCookie = Array.isArray(cookies)
        ? cookies.find((cookie: string) => cookie.startsWith(`${COOKIE_NAME}=`))
        : undefined;
      expect(sessionCookie).toBeDefined();
      expect(sessionCookie).toContain('session-123');
      expect(sessionCookie).toContain('HttpOnly');
      expect(sessionCookie).toContain('SameSite=Lax');
    });

    it('should set cookie with correct max age', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({ username: 'testuser', password: 'testpass' });

      expect(response.status).toBe(200);

      const cookies = response.headers['set-cookie'];
      const sessionCookie = Array.isArray(cookies)
        ? cookies.find((cookie: string) => cookie.startsWith(`${COOKIE_NAME}=`))
        : undefined;

      const expectedMaxAge = Math.floor((mockSession.expiresAt - mockSession.createdAt) / 1000);
      expect(sessionCookie).toContain(`Max-Age=${expectedMaxAge}`);
    });

    it('should handle empty string username and password', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({ username: '', password: '' });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Username and password required' });
    });

    it('should handle null and undefined values', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({ username: null, password: undefined });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Username and password required' });
    });
  });

  describe('POST /api/auth/logout', () => {
    it('should logout successfully without session cookie', async () => {
      const response = await request(app)
        .post('/api/auth/logout');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true });
      expect(mockAuthService.invalidateSession).not.toHaveBeenCalled();
    });

    it('should logout successfully with session cookie', async () => {
      const response = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', `${COOKIE_NAME}=session-123`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true });
      expect(mockAuthService.invalidateSession).toHaveBeenCalledWith('session-123');
    });

    it('should clear session cookie on logout', async () => {
      const response = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', `${COOKIE_NAME}=session-123`);

      expect(response.status).toBe(200);

      const cookies = response.headers['set-cookie'];
      expect(cookies).toBeDefined();

      const clearCookie = Array.isArray(cookies)
        ? cookies.find((cookie: string) => cookie.startsWith(`${COOKIE_NAME}=`))
        : undefined;
      expect(clearCookie).toBeDefined();
      expect(clearCookie).toContain('Expires=Thu, 01 Jan 1970'); // Cookie cleared
    });

    it('should handle malformed cookie header', async () => {
      const response = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', 'invalid-cookie-format');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true });
      expect(mockAuthService.invalidateSession).not.toHaveBeenCalled();
    });

    it('should handle multiple cookies with session cookie', async () => {
      const response = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', `other-cookie=value; ${COOKIE_NAME}=session-456; another=test`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true });
      expect(mockAuthService.invalidateSession).toHaveBeenCalledWith('session-456');
    });
  });

  describe('GET /api/auth/status', () => {
    it('should return not authenticated when no session cookie', async () => {
      const response = await request(app)
        .get('/api/auth/status');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ authenticated: false });
      expect(mockAuthService.validateSession).not.toHaveBeenCalled();
    });

    it('should return not authenticated when session is invalid', async () => {
      mockAuthService.validateSession.mockReturnValue(false);

      const response = await request(app)
        .get('/api/auth/status')
        .set('Cookie', `${COOKIE_NAME}=invalid-session`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ authenticated: false });
      expect(mockAuthService.validateSession).toHaveBeenCalledWith('invalid-session');
    });

    it('should return authenticated when session is valid', async () => {
      mockAuthService.validateSession.mockReturnValue(true);

      const response = await request(app)
        .get('/api/auth/status')
        .set('Cookie', `${COOKIE_NAME}=valid-session`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ authenticated: true });
      expect(mockAuthService.validateSession).toHaveBeenCalledWith('valid-session');
    });

    it('should handle malformed cookie in status check', async () => {
      const response = await request(app)
        .get('/api/auth/status')
        .set('Cookie', 'malformed-cookie');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ authenticated: false });
      expect(mockAuthService.validateSession).not.toHaveBeenCalled();
    });

    it('should extract session from multiple cookies', async () => {
      mockAuthService.validateSession.mockReturnValue(true);

      const response = await request(app)
        .get('/api/auth/status')
        .set('Cookie', `other=value; ${COOKIE_NAME}=session-789; test=data`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ authenticated: true });
      expect(mockAuthService.validateSession).toHaveBeenCalledWith('session-789');
    });
  });

  describe('Router integration', () => {
    it('should handle unsupported HTTP methods', async () => {
      await request(app)
        .put('/api/auth/login')
        .expect(404);

      await request(app)
        .get('/api/auth/login')
        .expect(404);

      await request(app)
        .delete('/api/auth/status')
        .expect(404);
    });

    it('should handle non-existent endpoints', async () => {
      await request(app)
        .get('/api/auth/nonexistent')
        .expect(404);

      await request(app)
        .post('/api/auth/invalid')
        .expect(404);
    });

    it('should handle JSON parsing errors gracefully', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .set('Content-Type', 'application/json')
        .send('invalid-json{');

      expect(response.status).toBe(400);
    });
  });

  describe('Edge cases', () => {
    it('should handle missing body in login request', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .set('Content-Type', 'application/json');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Username and password required' });
    });

    it('should handle auth service throwing errors', async () => {
      mockAuthService.getCredentials.mockImplementation(() => {
        throw new Error('Service unavailable');
      });

      const response = await request(app)
        .post('/api/auth/login')
        .send({ username: 'test', password: 'test' });

      expect(response.status).toBe(500);
    });

    it('should handle createSession throwing errors', async () => {
      mockAuthService.getCredentials.mockReturnValue(mockCredentials);
      mockAuthService.createSession.mockImplementation(() => {
        throw new Error('Session creation failed');
      });

      const response = await request(app)
        .post('/api/auth/login')
        .send({ username: 'testuser', password: 'testpass' });

      expect(response.status).toBe(500);
    });

    it('should handle validateSession throwing errors in status check', async () => {
      mockAuthService.validateSession.mockImplementation(() => {
        throw new Error('Validation failed');
      });

      const response = await request(app)
        .get('/api/auth/status')
        .set('Cookie', `${COOKIE_NAME}=session-123`);

      expect(response.status).toBe(500);
    });
  });
});
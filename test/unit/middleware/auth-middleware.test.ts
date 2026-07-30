import { Request, Response, NextFunction } from 'express';
import {
  createAuthMiddleware,
  parseCookie,
  COOKIE_NAME,
  getSessionCookieName
} from '../../../src/middleware/auth-middleware';
import { AuthService } from '../../../src/services/auth-service';

describe('auth-middleware', () => {
  describe('parseCookie', () => {
    it('should parse cookie value from header', () => {
      const header = 'session_id=abc123; other=value';
      const result = parseCookie(header, 'session_id');

      expect(result).toBe('abc123');
    });

    it('should return null for missing cookie', () => {
      const header = 'other=value';
      const result = parseCookie(header, 'session_id');

      expect(result).toBeNull();
    });

    it('should return null for undefined header', () => {
      const result = parseCookie(undefined, 'session_id');

      expect(result).toBeNull();
    });

    it('should return null for empty header', () => {
      const result = parseCookie('', 'session_id');

      expect(result).toBeNull();
    });

    it('should handle cookie with no spaces', () => {
      const header = 'name=value;other=test';
      const result = parseCookie(header, 'name');

      expect(result).toBe('value');
    });

    it('should handle cookie with extra spaces', () => {
      const header = '  name=value  ;  other=test  ';
      const result = parseCookie(header, 'name');

      expect(result).toBe('value');
    });

    it('should parse the claudito_session cookie', () => {
      const header = `${COOKIE_NAME}=test-session-id; other=value`;
      const result = parseCookie(header, COOKIE_NAME);

      expect(result).toBe('test-session-id');
    });

    it('should handle cookie with equals sign in value', () => {
      const header = 'token=abc=def=ghi; other=value';
      const result = parseCookie(header, 'token');

      expect(result).toBe('abc=def=ghi');
    });
  });

  describe('COOKIE_NAME', () => {
    it('should include port in cookie name', () => {
      const expectedSuffix = (process.env.PORT || '').trim().replace(/[^0-9]/g, '') || '3000';
      expect(COOKIE_NAME).toBe(`claudito_session_${expectedSuffix}`);
    });

    it('should be a valid cookie name', () => {
      // A cookie name cannot contain whitespace or separators. PORT="4001 " used
      // to leak straight into the name, making every request 401 for no visible
      // reason.
      expect(COOKIE_NAME).toMatch(/^[A-Za-z0-9_]+$/);
    });
  });

  describe('getSessionCookieName', () => {
    it('should return the cookie name', () => {
      expect(getSessionCookieName()).toBe(COOKIE_NAME);
    });
  });

  describe('createAuthMiddleware', () => {
    let mockAuthService: jest.Mocked<AuthService>;
    let mockRequest: Partial<Request>;
    let mockResponse: Partial<Response>;
    let mockNext: jest.MockedFunction<NextFunction>;

    beforeEach(() => {
      mockAuthService = {
        getCredentials: jest.fn(),
        createSession: jest.fn(),
        validateSession: jest.fn(),
        invalidateSession: jest.fn()
      };

      mockRequest = {
        headers: {}
      };

      mockResponse = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis()
      };

      mockNext = jest.fn();
    });

    it('should call next() for valid session', () => {
      mockAuthService.validateSession.mockReturnValue(true);
      mockRequest.headers = {
        cookie: `${COOKIE_NAME}=valid-session-id`
      };

      const middleware = createAuthMiddleware({ authService: mockAuthService });
      middleware(
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(mockAuthService.validateSession).toHaveBeenCalledWith('valid-session-id');
      expect(mockNext).toHaveBeenCalled();
      expect(mockResponse.status).not.toHaveBeenCalled();
    });

    it('should return 401 for missing cookie', () => {
      mockRequest.headers = {};

      const middleware = createAuthMiddleware({ authService: mockAuthService });
      middleware(
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: 'Unauthorized',
        code: 'AUTH_REQUIRED'
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should return 401 for invalid session', () => {
      mockAuthService.validateSession.mockReturnValue(false);
      mockRequest.headers = {
        cookie: `${COOKIE_NAME}=invalid-session-id`
      };

      const middleware = createAuthMiddleware({ authService: mockAuthService });
      middleware(
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(mockAuthService.validateSession).toHaveBeenCalledWith('invalid-session-id');
      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: 'Unauthorized',
        code: 'AUTH_REQUIRED'
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should return 401 for empty session ID in cookie', () => {
      mockAuthService.validateSession.mockReturnValue(false);
      mockRequest.headers = {
        cookie: `${COOKIE_NAME}=`
      };

      const middleware = createAuthMiddleware({ authService: mockAuthService });
      middleware(
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should handle undefined cookie header', () => {
      mockRequest.headers = { cookie: undefined };

      const middleware = createAuthMiddleware({ authService: mockAuthService });
      middleware(
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockNext).not.toHaveBeenCalled();
    });
  });
});

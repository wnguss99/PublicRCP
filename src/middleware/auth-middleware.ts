/**
 * Authentication Middleware
 * Validates session cookies and protects API routes
 */

import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../services/auth-service';

/**
 * Session cookie name, scoped to the port.
 *
 * Browsers do not isolate cookies by port, so all instances on this host would
 * otherwise overwrite each other's session and logging into one would log you out
 * of the next. The port is folded into the name to keep them apart.
 *
 * The value is sanitised because a cookie name may not contain whitespace or
 * separators: `PORT="4001 "` would produce an invalid name and every request
 * would come back 401 with nothing in the logs to explain it. Digits only, and
 * fall back to the same default the config loader uses.
 */
function cookieNameSuffix(): string {
  const digits = (process.env.PORT || '').trim().replace(/[^0-9]/g, '');
  return digits === '' ? '3000' : digits;
}

export const COOKIE_NAME = `claudito_session_${cookieNameSuffix()}`;

export interface AuthMiddlewareDependencies {
  authService: AuthService;
}

/**
 * Parse a specific cookie value from the Cookie header
 */
export function parseCookie(
  cookieHeader: string | undefined,
  name: string
): string | null {
  if (!cookieHeader) {
    return null;
  }

  const cookies = cookieHeader.split(';');

  for (const cookie of cookies) {
    const [cookieName, ...rest] = cookie.trim().split('=');

    if (cookieName === name) {
      return rest.join('='); // Handle values with '=' in them
    }
  }

  return null;
}

/**
 * True when the request originates from this machine.
 *
 * Express reports IPv4-mapped addresses as ::ffff:127.0.0.1, and a request that
 * arrives over the IPv6 loopback shows up as ::1.
 */
export function isLoopbackRequest(req: Request): boolean {
  const raw = req.socket?.remoteAddress || req.ip || '';

  if (raw === '') {
    return false;
  }

  const address = raw.startsWith('::ffff:') ? raw.slice('::ffff:'.length) : raw;

  if (address === '::1' || address === '127.0.0.1') {
    return true;
  }

  return address.startsWith('127.');
}

/**
 * Create middleware that validates session cookies
 * Returns 401 for unauthenticated requests
 */
export function createAuthMiddleware(deps: AuthMiddlewareDependencies) {
  const { authService } = deps;

  return (req: Request, res: Response, next: NextFunction): void => {
    // Health check is public (auth is optional via ?auth=1 query param)
    if (req.path === '/health') {
      next();
      return;
    }

    // MCP servers are called by the locally-spawned Claude CLI process, which
    // has no browser cookie, so they cannot require a session. They are NOT
    // implicitly loopback-only though — the server binds 0.0.0.0, so without
    // this check anyone on the LAN/Tailnet could answer permission prompts or
    // send mail through /api/mcp/*. Enforce what the design already assumed:
    // the caller must be our own machine.
    //
    // Containerised agents are unaffected: with the default bridge network a
    // container cannot reach the host's 127.0.0.1 in the first place, so MCP was
    // already host-only. If containers are ever given host networking or
    // host.docker.internal, this check has to learn about the gateway address.
    if (typeof req.path === 'string' && req.path.startsWith('/mcp/')) {
      if (isLoopbackRequest(req)) {
        next();
        return;
      }

      res.status(403).json({ error: 'Forbidden', code: 'MCP_LOOPBACK_ONLY' });
      return;
    }

    const sessionId = parseCookie(req.headers.cookie, COOKIE_NAME);

    if (!sessionId || !authService.validateSession(sessionId)) {
      res.status(401).json({ error: 'Unauthorized', code: 'AUTH_REQUIRED' });
      return;
    }

    next();
  };
}

/**
 * Get the session cookie name
 */
export function getSessionCookieName(): string {
  return COOKIE_NAME;
}

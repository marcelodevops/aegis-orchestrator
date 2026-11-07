/**
 * Aegis Orchestrator - Authentication Middleware & Token Policy
 * 
 * Protects mutating endpoints against unauthorized access.
 */

import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { storage } from '../storage/db.js';

const AUTH_SETTING_KEY = 'system:auth_token';

let activeAuthToken: string = process.env.AEGIS_AUTH_TOKEN || '';

export function getOrGenerateAuthToken(): string {
  if (activeAuthToken) return activeAuthToken;

  const stored = storage.getSetting(AUTH_SETTING_KEY);
  if (stored && typeof stored.token === 'string' && stored.token.length > 0) {
    activeAuthToken = stored.token;
    return activeAuthToken;
  }

  // Generate a cryptographically secure 32-byte hex token
  activeAuthToken = crypto.randomBytes(32).toString('hex');
  storage.setSetting(AUTH_SETTING_KEY, { token: activeAuthToken }, true);
  return activeAuthToken;
}

// Initialize on module load
getOrGenerateAuthToken();

/**
 * Validates token on mutating HTTP methods (POST, PUT, DELETE, PATCH).
 * GET / HEAD / OPTIONS are permitted for read operations.
 */
export function requireAuthToken(req: Request, res: Response, next: NextFunction): void {
  // Safe read methods pass through
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  // Exempt public auth info endpoint
  if (req.path === '/api/auth/session') {
    return next();
  }

  const headerToken = req.headers['x-aegis-auth-token'] as string;
  const authHeader = req.headers['authorization'] as string;
  let bearerToken: string | undefined;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    bearerToken = authHeader.substring(7).trim();
  }

  const candidate = headerToken || bearerToken;
  const serverToken = getOrGenerateAuthToken();

  if (!candidate || candidate !== serverToken) {
    res.status(401).json({
      error: 'Unauthorized: Mutating actions require valid X-Aegis-Auth-Token header',
      code: 'AUTH_REQUIRED',
    });
    return;
  }

  next();
}

/**
 * Validates a candidate token string directly (for internal services or test suites)
 */
export function isValidToken(candidate?: string): boolean {
  if (!candidate) return false;
  return candidate === getOrGenerateAuthToken();
}

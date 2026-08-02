import type { Env } from '../../config/env.js';

export const SESSION_COOKIE_NAME = 'token';

export function sessionCookieOptions(config: Env) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.COOKIE_SECURE,
    path: '/',
    maxAge: config.JWT_SESSION_SECONDS,
  };
}

export function sessionJwtOptions(config: Env) {
  return { expiresIn: config.JWT_SESSION_SECONDS };
}

export const clearSessionCookieOptions = { path: '/' } as const;

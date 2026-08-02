import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/config/env.js';
import { clearSessionCookieOptions, sessionCookieOptions, sessionJwtOptions } from '../src/modules/auth/session.js';

const env: Env = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://depot:depot@localhost:5432/depot_drive',
  JWT_SECRET: 'a-development-secret-that-is-long-enough',
  API_PORT: 3000,
  WEB_ORIGIN: 'http://localhost:5173',
  COOKIE_SECURE: false,
  JWT_SESSION_SECONDS: 604_800,
  MAX_FILE_SIZE_BYTES: 524_288_000,
  UPLOAD_ROOT: './uploads',
};

describe('authentication session lifecycle', () => {
  it('signs JWTs for seven days rather than seconds or minutes', async () => {
    const app = Fastify();
    await app.register(jwt, { secret: env.JWT_SECRET });
    const token = app.jwt.sign({ sub: 'user-id', email: 'user@example.com' }, sessionJwtOptions(env));
    const payload = app.jwt.decode<{ iat: number; exp: number }>(token);

    expect(payload).not.toBeNull();
    expect(payload!.exp - payload!.iat).toBe(604_800);
    await app.close();
  });

  it('keeps cookie and JWT lifetimes aligned with safe development flags', () => {
    const cookie = sessionCookieOptions(env);
    expect(cookie.maxAge).toBe(sessionJwtOptions(env).expiresIn);
    expect(cookie.maxAge).toBe(604_800);
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'lax', secure: false, path: '/' });
    expect(cookie).not.toHaveProperty('domain');
    expect(clearSessionCookieOptions).toEqual({ path: '/' });
  });
});

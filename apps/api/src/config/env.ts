import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'node:path';
import { MAX_UPLOAD_FILE_SIZE } from '@depot-drive/shared';

// Workspace scripts run with apps/api as cwd; also load the monorepo-root .env documented in README.
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(1),
  API_PORT: z.coerce.number().int().positive().default(3000),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  COOKIE_SECURE: z.string().default('false').transform((v) => v === 'true'),
  JWT_SESSION_SECONDS: z.coerce.number().int().min(3600).default(604_800),
  CHUNK_SIZE_BYTES: z.coerce.number().int().min(1024).default(8 * 1024 * 1024),
  UPLOAD_SESSION_TTL_SECONDS: z.coerce.number().int().min(300).default(86_400),
  MAX_FILE_SIZE_BYTES: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(MAX_UPLOAD_FILE_SIZE),
  UPLOAD_ROOT: z.string().default('./uploads'),
});

export type Env = z.infer<typeof schema>;
export function loadEnv(input: NodeJS.ProcessEnv = process.env): Env {
  const env = schema.parse(input);
  if (env.NODE_ENV !== 'test' && env.JWT_SECRET.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
  return env;
}

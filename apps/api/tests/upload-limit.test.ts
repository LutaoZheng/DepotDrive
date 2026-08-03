import { describe, expect, it } from 'vitest';
import { MAX_UPLOAD_FILE_SIZE } from '@depot-drive/shared';
import { loadEnv } from '../src/config/env.js';

describe('shared upload size limit',()=>{
  it('uses the shared 5 GB limit as the backend default without 32-bit overflow',()=>{const env=loadEnv({NODE_ENV:'test',DATABASE_URL:'postgresql://test',JWT_SECRET:'test'});expect(env.MAX_FILE_SIZE_BYTES).toBe(MAX_UPLOAD_FILE_SIZE);expect(env.MAX_FILE_SIZE_BYTES).toBe(5*1024*1024*1024);expect(env.MAX_FILE_SIZE_BYTES).toBeGreaterThan(2_147_483_647);expect(Number.isSafeInteger(env.MAX_FILE_SIZE_BYTES)).toBe(true)});
});

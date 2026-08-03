import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveUploadRoot, WORKSPACE_ROOT } from '../src/config/env.js';

describe('storage root resolution', () => {
  it('resolves relative paths once against the workspace regardless of process cwd', () => {
    expect(resolveUploadRoot('./apps/api/uploads')).toBe(path.join(WORKSPACE_ROOT, 'apps/api/uploads'));
    expect(resolveUploadRoot('./apps/api/uploads')).not.toContain('apps/api/apps/api/uploads');
  });
  it('preserves normalized absolute upload roots', () => {
    expect(resolveUploadRoot('/tmp/depot-storage')).toBe(path.normalize('/tmp/depot-storage'));
  });
});

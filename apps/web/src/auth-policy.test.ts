import axios from 'axios';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { clearUserQueryCache, createUnauthorizedCoordinator, protectedQueryEnabled, shouldRetryQuery } from './auth-policy';

function unauthorizedError() {
  return new axios.AxiosError('Unauthorized', 'ERR_BAD_REQUEST', undefined, undefined, {
    data: { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
    status: 401,
    statusText: 'Unauthorized',
    headers: {},
    config: { headers: new axios.AxiosHeaders() },
  });
}

describe('global unauthorized policy', () => {
  it('handles concurrent 401s once, clears stale identity/cache, and redirects to login', async () => {
    const client = new QueryClient();
    client.setQueryData(['directory', null], { files: ['first-user-file'] });
    client.setQueryData(['usage'], { usedBytes: 42 });
    let user: { email: string } | null = { email: 'first@example.com' };
    let route = '/drive';
    const clearUser = vi.fn(() => { user = null; });
    const redirectToLogin = vi.fn(() => { route = '/login'; });
    const coordinator = createUnauthorizedCoordinator({ client, clearUser, redirectToLogin });

    await Promise.all([coordinator.handle(), coordinator.handle(), coordinator.handle()]);

    expect(clearUser).toHaveBeenCalledTimes(1);
    expect(redirectToLogin).toHaveBeenCalledTimes(1);
    expect(user).toBeNull();
    expect(route).toBe('/login');
    expect(client.getQueryData(['directory', null])).toBeUndefined();
    expect(client.getQueryData(['usage'])).toBeUndefined();
    expect(protectedQueryEnabled(user)).toBe(false);
  });

  it('never retries a 401', () => {
    expect(shouldRetryQuery(0, unauthorizedError())).toBe(false);
    expect(shouldRetryQuery(0, new Error('temporary failure'))).toBe(true);
    expect(shouldRetryQuery(1, new Error('temporary failure'))).toBe(false);
  });

  it('removes the previous user cache before a second user session', async () => {
    const client = new QueryClient();
    client.setQueryData(['directory', null], { owner: 'first@example.com' });
    client.setQueryData(['storage'], { owner: 'first@example.com', usedBytes: 500 });

    await clearUserQueryCache(client);

    expect(client.getQueryData(['directory', null])).toBeUndefined();
    expect(client.getQueryData(['storage'])).toBeUndefined();
    expect(protectedQueryEnabled({ email: 'second@example.com' })).toBe(true);
  });
});

import type { QueryClient } from '@tanstack/react-query';
import axios from 'axios';

const userQueryRoots = new Set(['directory', 'folders', 'files', 'breadcrumbs', 'usage', 'storage']);

export const protectedQueryEnabled = (user: unknown): boolean => Boolean(user);

export function isUnauthorized(error: unknown): boolean {
  return axios.isAxiosError(error) && error.response?.status === 401;
}

export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  return !isUnauthorized(error) && failureCount < 1;
}

export async function clearUserQueryCache(client: QueryClient): Promise<void> {
  const predicate = (query: { queryKey: readonly unknown[] }) => userQueryRoots.has(String(query.queryKey[0]));
  await client.cancelQueries({ predicate });
  client.removeQueries({ predicate });
}

export function createUnauthorizedCoordinator(options: {
  client: QueryClient;
  clearUser: () => void;
  redirectToLogin: () => void;
}) {
  let handled = false;
  return {
    async handle() {
      if (handled) return;
      handled = true;
      options.clearUser();
      await clearUserQueryCache(options.client);
      options.redirectToLogin();
    },
    reset() { handled = false; },
  };
}

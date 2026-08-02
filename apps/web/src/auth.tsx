import { createContext, useCallback, useContext, useEffect, useMemo, useState, type PropsWithChildren } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { AuthResponse, UserDto } from '@depot-drive/shared';
import { api } from './api';
import { clearUserQueryCache, createUnauthorizedCoordinator, isUnauthorized } from './auth-policy';

type Auth = {
  user: UserDto | null;
  loading: boolean;
  establishSession: () => Promise<void>;
  logout: () => Promise<void>;
};

const Context = createContext<Auth | null>(null);

export function AuthProvider({ children }: PropsWithChildren) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [user, setUser] = useState<UserDto | null>(null);
  const [loading, setLoading] = useState(true);
  const coordinator = useMemo(() => createUnauthorizedCoordinator({
    client,
    clearUser: () => setUser(null),
    redirectToLogin: () => navigate('/login', { replace: true }),
  }), [client, navigate]);

  useEffect(() => {
    const interceptor = api.interceptors.response.use(
      (response) => response,
      (error: unknown) => {
        if (isUnauthorized(error)) void coordinator.handle();
        return Promise.reject(error);
      },
    );
    return () => api.interceptors.response.eject(interceptor);
  }, [coordinator]);

  useEffect(() => {
    let active = true;
    api.get<AuthResponse>('/api/auth/me')
      .then((response) => { if (active) setUser(response.data.user); })
      .catch((error: unknown) => { if (active && !isUnauthorized(error)) setUser(null); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const establishSession = useCallback(async () => {
    setLoading(true);
    setUser(null);
    await clearUserQueryCache(client);
    coordinator.reset();
    try {
      const response = await api.get<AuthResponse>('/api/auth/me');
      setUser(response.data.user);
      navigate('/drive', { replace: true });
    } finally {
      setLoading(false);
    }
  }, [client, coordinator, navigate]);

  const logout = useCallback(async () => {
    try { await api.post('/api/auth/logout'); }
    finally {
      setUser(null);
      await clearUserQueryCache(client);
      navigate('/login', { replace: true });
    }
  }, [client, navigate]);

  return <Context.Provider value={{ user, loading, establishSession, logout }}>{children}</Context.Provider>;
}

export function useAuth() {
  const value = useContext(Context);
  if (!value) throw new Error('AuthProvider missing');
  return value;
}

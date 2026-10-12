'use client';

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from 'react';
import type { User, LoginRequest, RegisterRequest, Problem } from '@winkey/api-client';
import { api, refreshSession } from '../api-client';
import { tokenStore } from './token-store';
import {
  hasSessionIndicator,
  setSessionIndicator,
  clearSessionIndicator,
} from './session-indicator';
import { resetCachedWatchLaterId } from '../playlist/playlist-utils';

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  isCreator: boolean;
  isModerator: boolean;
  isAdmin: boolean;
  canAccessAdmin: boolean;
  login: (credentials: LoginRequest) => Promise<{ success: boolean; error?: Problem }>;
  register: (data: RegisterRequest) => Promise<{ success: boolean; error?: Problem }>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  updateUser: (user: User) => void;
  clearSession: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!hasSessionIndicator()) {
      tokenStore.clear();
      setUser(null);
      setIsLoading(false);
      return;
    }

    try {
      const { token, user: refreshedUser } = await refreshSession();
      if (token) {
        setSessionIndicator();
        if (refreshedUser) {
          setUser(refreshedUser);
        } else {
          const { data, response } = await api.auth.GET('/v1/auth/me');
          if (response.ok && data) {
            setUser(data);
          } else {
            tokenStore.clear();
            clearSessionIndicator();
            setUser(null);
          }
        }
      } else {
        tokenStore.clear();
        clearSessionIndicator();
        setUser(null);
      }
    } catch {
      tokenStore.clear();
      clearSessionIndicator();
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    // Session restore on initial mount: only refresh if we have a session indicator
    if (!hasSessionIndicator()) {
      setIsLoading(false);
      return;
    }
    refresh();
  }, [refresh]);

  useEffect(() => {
    resetCachedWatchLaterId();
  }, [user?.id]);

  const login = useCallback(async (credentials: LoginRequest) => {
    setIsLoading(true);
    try {
      const { data, error, response } = await api.auth.POST('/v1/auth/login', {
        body: credentials,
      });

      if (response.ok && data) {
        tokenStore.set(data.access_token);
        setSessionIndicator();
        setUser(data.user);
        return { success: true };
      }

      return {
        success: false,
        error: error as Problem,
      };
    } catch (err: unknown) {
      return {
        success: false,
        error: {
          type: '/problems/unknown',
          title: 'Network Error',
          status: 500,
          detail: (err as { message?: string })?.message || 'Failed to sign in',
        },
      };
    } finally {
      setIsLoading(false);
    }
  }, []);

  const register = useCallback(async (regData: RegisterRequest) => {
    setIsLoading(true);
    try {
      const { data, error, response } = await api.auth.POST('/v1/auth/register', {
        body: regData,
      });

      if (response.ok && data) {
        tokenStore.set(data.access_token);
        setSessionIndicator();
        setUser(data.user);
        return { success: true };
      }

      return {
        success: false,
        error: error as Problem,
      };
    } catch (err: unknown) {
      return {
        success: false,
        error: {
          type: '/problems/unknown',
          title: 'Network Error',
          status: 500,
          detail: (err as { message?: string })?.message || 'Failed to register',
        },
      };
    } finally {
      setIsLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.auth.POST('/v1/auth/logout');
    } finally {
      tokenStore.clear();
      clearSessionIndicator();
      setUser(null);
      resetCachedWatchLaterId();
    }
  }, []);

  const updateUser = useCallback((updatedUser: User) => {
    setUser(updatedUser);
  }, []);

  const clearSession = useCallback(() => {
    tokenStore.clear();
    clearSessionIndicator();
    setUser(null);
    resetCachedWatchLaterId();
  }, []);

  const isCreator = !!user?.roles?.includes('creator');
  const isModerator = !!user?.roles?.includes('moderator');
  const isAdmin = !!user?.roles?.includes('admin');
  const canAccessAdmin = isModerator || isAdmin;

  const contextValue = useMemo(
    () => ({
      user,
      isLoading,
      isAuthenticated: !!user,
      isCreator,
      isModerator,
      isAdmin,
      canAccessAdmin,
      login,
      register,
      logout,
      refresh,
      updateUser,
      clearSession,
    }),
    [
      user,
      isLoading,
      isCreator,
      isModerator,
      isAdmin,
      canAccessAdmin,
      login,
      register,
      logout,
      refresh,
      updateUser,
      clearSession,
    ],
  );

  return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

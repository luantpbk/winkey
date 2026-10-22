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
  shouldProbeSession,
  setSessionIndicator,
  clearSessionIndicator,
  setSessionProbed,
  consumeOAuthReturnMarker,
} from './session-indicator';
import { resetCachedWatchLaterId } from '../playlist/playlist-utils';
import { computePermissions, type UserPermissions, ANONYMOUS_PERMISSIONS } from './permissions';

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  can: UserPermissions;
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
    if (!hasSessionIndicator() && !shouldProbeSession()) {
      tokenStore.clear();
      setUser(null);
      setIsLoading(false);
      return;
    }

    try {
      const { token, user: refreshedUser } = await refreshSession();
      if (token) {
        setSessionIndicator();
        setSessionProbed();
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
      setSessionProbed();
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    // Back from Google sign-in: the callback only set the HttpOnly refresh cookie, so mark the
    // session and refresh (a failed refresh clears the indicator again).
    if (consumeOAuthReturnMarker()) {
      setSessionIndicator();
    }
    // Session restore on initial mount: only refresh if we have a session indicator or need to probe
    if (!hasSessionIndicator() && !shouldProbeSession()) {
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
        setSessionProbed();
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
        setSessionProbed();
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
      setSessionProbed();
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
    setSessionProbed();
    setUser(null);
    resetCachedWatchLaterId();
  }, []);

  const isCreator = !!user?.roles?.includes('creator');
  const isModerator = !!user?.roles?.includes('moderator');
  const isAdmin = !!user?.roles?.includes('admin');
  const canAccessAdmin = isModerator || isAdmin;
  const can = useMemo(() => computePermissions(user, !!user), [user]);

  const contextValue = useMemo(
    () => ({
      user,
      isLoading,
      isAuthenticated: !!user,
      can,
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
      can,
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

const DEFAULT_AUTH_CONTEXT: AuthContextType = {
  user: null,
  isLoading: false,
  isAuthenticated: false,
  can: ANONYMOUS_PERMISSIONS,
  isCreator: false,
  isModerator: false,
  isAdmin: false,
  canAccessAdmin: false,
  login: async () => ({ success: false }),
  register: async () => ({ success: false }),
  logout: async () => {},
  refresh: async () => {},
  updateUser: () => {},
  clearSession: () => {},
};

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    return DEFAULT_AUTH_CONTEXT;
  }
  return context;
}

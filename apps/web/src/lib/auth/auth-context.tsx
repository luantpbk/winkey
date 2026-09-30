'use client';

import React, { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { User, LoginRequest, RegisterRequest, Problem } from '@winkey/api-client';
import { api, refreshAccessToken } from '../api-client';
import { tokenStore } from './token-store';

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
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = async () => {
    try {
      const token = await refreshAccessToken();
      if (token) {
        const { data } = await api.auth.GET('/v1/auth/me');
        if (data) {
          setUser(data);
        }
      } else {
        tokenStore.clear();
        setUser(null);
      }
    } catch {
      tokenStore.clear();
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    // Session restore on initial mount
    refresh();
  }, []);

  const login = async (credentials: LoginRequest) => {
    setIsLoading(true);
    try {
      const { data, error, response } = await api.auth.POST('/v1/auth/login', {
        body: credentials,
      });

      if (response.ok && data) {
        tokenStore.set(data.access_token);
        setUser(data.user);
        if (typeof document !== 'undefined') {
          const role = data.user.roles.includes('admin')
            ? 'admin'
            : data.user.roles.includes('moderator')
              ? 'moderator'
              : 'creator';
          document.cookie = `wk_mock_role=${role}; path=/; max-age=86400; SameSite=Lax`;
        }
        return { success: true };
      }

      return {
        success: false,
        error: error as Problem,
      };
    } catch (err: any) {
      return {
        success: false,
        error: {
          type: '/problems/unknown',
          title: 'Network Error',
          status: 500,
          detail: err?.message || 'Failed to sign in',
        },
      };
    } finally {
      setIsLoading(false);
    }
  };

  const register = async (regData: RegisterRequest) => {
    setIsLoading(true);
    try {
      const { data, error, response } = await api.auth.POST('/v1/auth/register', {
        body: regData,
      });

      if (response.ok && data) {
        tokenStore.set(data.access_token);
        setUser(data.user);
        if (typeof document !== 'undefined') {
          document.cookie = 'wk_mock_role=creator; path=/; max-age=86400; SameSite=Lax';
        }
        return { success: true };
      }

      return {
        success: false,
        error: error as Problem,
      };
    } catch (err: any) {
      return {
        success: false,
        error: {
          type: '/problems/unknown',
          title: 'Network Error',
          status: 500,
          detail: err?.message || 'Failed to register',
        },
      };
    } finally {
      setIsLoading(false);
    }
  };

  const logout = async () => {
    try {
      await api.auth.POST('/v1/auth/logout');
    } finally {
      tokenStore.clear();
      setUser(null);
      if (typeof document !== 'undefined') {
        document.cookie = 'wk_mock_role=; path=/; max-age=0; SameSite=Lax';
      }
    }
  };

  const isCreator = !!user?.roles?.includes('creator');
  const isModerator = !!user?.roles?.includes('moderator');
  const isAdmin = !!user?.roles?.includes('admin');
  const canAccessAdmin = isModerator || isAdmin;

  return (
    <AuthContext.Provider
      value={{
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
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

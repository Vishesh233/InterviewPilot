'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';

const TOKEN_KEY = 'trao_interview_token';
const USER_KEY = 'trao_interview_user';
const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [token, setToken] = useState(null);
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    try {
      setToken(window.localStorage.getItem(TOKEN_KEY));
      const storedUser = window.localStorage.getItem(USER_KEY);
      if (storedUser) setUser(JSON.parse(storedUser));
    } catch {
      window.localStorage.removeItem(TOKEN_KEY);
      window.localStorage.removeItem(USER_KEY);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const handleUnauthorized = () => {
      window.localStorage.removeItem(TOKEN_KEY);
      window.localStorage.removeItem(USER_KEY);
      setToken(null);
      setUser(null);
    };
    window.addEventListener('trao:unauthorized', handleUnauthorized);
    return () => window.removeEventListener('trao:unauthorized', handleUnauthorized);
  }, []);

  const saveSession = (nextToken, nextUser) => {
    window.localStorage.setItem(TOKEN_KEY, nextToken);
    window.localStorage.setItem(USER_KEY, JSON.stringify(nextUser || {}));
    setToken(nextToken);
    setUser(nextUser || null);
  };

  const value = useMemo(() => ({
    token,
    user,
    loading,
    isAuthenticated: Boolean(token),
    async login(credentials) {
      const result = await api.login(credentials);
      saveSession(result.token, result.user);
      return result.user;
    },
    async register(credentials) {
      await api.register(credentials);
      const result = await api.login(credentials);
      saveSession(result.token, result.user);
      return result.user;
    },
    logout() {
      window.localStorage.removeItem(TOKEN_KEY);
      window.localStorage.removeItem(USER_KEY);
      setToken(null);
      setUser(null);
    },
  }), [loading, token, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}

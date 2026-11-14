import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { api, setCsrfToken } from './api';
import { ChangePassword } from '../pages/change-password';
import type { AuthUser } from './types';

interface AuthState {
  user: AuthUser | null;
  authKind: string;
  authMode: string;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authKind, setAuthKind] = useState('service');
  const [authMode, setAuthMode] = useState('legacy');
  const [loading, setLoading] = useState(true);

  const refresh = async (): Promise<void> => {
    try {
      const me = await api.me();
      setUser(me.user);
      setAuthKind(me.authKind);
      setAuthMode(me.authMode);
      setCsrfToken(me.csrfToken);
    } catch {
      setUser(null);
      setCsrfToken(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  const login = async (username: string, password: string): Promise<void> => {
    const result = await api.login(username, password);
    setUser(result.user);
    setCsrfToken(result.csrfToken);
    await refresh();
  };

  const changePassword = async (currentPassword: string, newPassword: string): Promise<void> => {
    const result = await api.changePassword(currentPassword, newPassword);
    setUser(result.user);
    setCsrfToken(result.csrfToken ?? null);
    await refresh();
  };

  const logout = async (): Promise<void> => {
    await api.logout().catch(() => undefined);
    setCsrfToken(null);
    setUser(null);
  };

  const value = useMemo(() => ({ user, authKind, authMode, loading, login, changePassword, logout, refresh }), [user, authKind, authMode, loading]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}

export function RequireOperator({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) {
    return <div className="flex min-h-screen items-center justify-center text-muted">正在验证登录…</div>;
  }
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== 'admin' && user.role !== 'operator') return <Navigate to="/" replace />;
  return <>{children}</>;
}

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) {
    return <div className="flex min-h-screen items-center justify-center text-muted">正在验证登录…</div>;
  }
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== 'admin') return <Navigate to="/" replace />;
  return <>{children}</>;
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) {
    return <div className="flex min-h-screen items-center justify-center text-muted">正在验证登录…</div>;
  }
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  // Bootstrap password => the only reachable screen is the change form.
  if (user.mustChangePassword) return <ChangePassword />;
  return <>{children}</>;
}

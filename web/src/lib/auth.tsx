import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, refreshAccessToken, setAccessToken, setSessionLostHandler } from './api';
import { connectSocket, disconnectSocket } from './socket';

export interface Me {
  id: number; name: string; email: string; employee_code: string; phone: string | null; timezone: string; must_change_password: boolean;
  department_id: number | null; department_name: string | null; team_id: number | null; team_name: string | null; designation: string | null;
  role: string; role_name: string; scope: 'organization' | 'project' | 'department' | 'team' | 'self'; permissions: string[];
}

interface AuthCtx {
  user: Me | null; loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  setUser: (u: Me) => void;
  can: (...perms: string[]) => boolean;
}

const Ctx = createContext<AuthCtx>(null as any);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const qc = useQueryClient();

  const setUser = useCallback((u: Me | null) => {
    setUserState(u);
    if (u) connectSocket(); else disconnectSocket();
  }, []);

  useEffect(() => {
    setSessionLostHandler(() => { setAccessToken(null); setUser(null); qc.clear(); });
    (async () => {
      const t = await refreshAccessToken();
      if (t) { try { setUser(await api<Me>('/auth/me')); } catch { /* signed out */ } }
      setLoading(false);
    })();
  }, [qc, setUser]);

  const login = useCallback(async (email: string, password: string) => {
    const r = await api<{ accessToken: string; user: Me }>('/auth/login', { body: { email, password } });
    setAccessToken(r.accessToken);
    setUser(r.user);
  }, [setUser]);

  const logout = useCallback(async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
    setAccessToken(null);
    setUser(null);
    qc.clear();
  }, [qc, setUser]);

  const value = useMemo<AuthCtx>(() => ({
    user, loading, login, logout, setUser: (u) => setUser(u),
    can: (...perms) => !!user && perms.some((p) => user.permissions.includes(p)),
  }), [user, loading, login, logout, setUser]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);

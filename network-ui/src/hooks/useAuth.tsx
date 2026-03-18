import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';

interface User { id: string; email: string; displayName: string; role: string; }
interface AuthContextType {
  user: User | null;
  token: string | null;
  login: (token: string, user: User) => void;
  logout: () => void;
  isLoading: boolean;
}

const API_BASE = import.meta.env.DEV ? 'http://localhost:3001' : '';

const AuthCtx = createContext<AuthContextType>(null!);
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const stored = localStorage.getItem('docnet_token');
    if (stored) {
      fetch(`${API_BASE}/api/auth/me`, { headers: { Authorization: `Bearer ${stored}` } })
        .then(r => r.ok ? r.json() : null)
        .then(u => { if (u) { setToken(stored); setUser(u); } else { localStorage.removeItem('docnet_token'); } })
        .finally(() => setIsLoading(false));
    } else {
      setIsLoading(false);
    }
  }, []);

  const login = (t: string, u: User) => {
    localStorage.setItem('docnet_token', t);
    setToken(t); setUser(u);
  };
  const logout = () => {
    localStorage.removeItem('docnet_token');
    setToken(null); setUser(null);
  };

  return <AuthCtx.Provider value={{ user, token, login, logout, isLoading }}>{children}</AuthCtx.Provider>;
}

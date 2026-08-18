import { createContext, useContext, useState, useEffect } from 'react';
import { api } from '../utils/api';
import { getToken, setToken, clearToken } from '../utils/api';

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (getToken()) {
      // On a real auth failure the api layer already clears the token and
      // redirects; a transient network/server error should NOT log the user
      // out, so keep the token and just finish loading.
      api.me().then(data => { setUser(data.user); setLoading(false); })
        .catch(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  const login = async (email, password) => {
    const data = await api.login(email, password);
    setToken(data.token);
    setUser(data.user);
    return data.user;
  };

  const logout = () => {
    clearToken();
    setUser(null);
  };

  return <AuthCtx.Provider value={{ user, login, logout, loading }}>{children}</AuthCtx.Provider>;
}

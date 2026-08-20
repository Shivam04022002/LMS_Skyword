import { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loginRequest, fetchCurrentUser, logoutRequest } from '../services/authService';
import { setUnauthorizedHandler } from '../services/api';
import { getStoredToken, storeToken, clearStoredToken } from '../utils/storage';

export const AuthContext = createContext(null);

/**
 * Owns the whole authentication lifecycle: session restore on startup, login,
 * logout, and reacting to a rejected token. Pages read it through `useAuth`.
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(() => getStoredToken());
  const [loading, setLoading] = useState(true);
  const isMounted = useRef(true);

  const clearSession = useCallback(() => {
    clearStoredToken();
    setToken(null);
    setUser(null);
  }, []);

  // A 401 from any request invalidates the session exactly once, here.
  useEffect(() => {
    setUnauthorizedHandler(() => clearSession());
    return () => setUnauthorizedHandler(null);
  }, [clearSession]);

  // Startup: restore the session if the stored token is still valid.
  useEffect(() => {
    isMounted.current = true;

    async function restoreSession() {
      const storedToken = getStoredToken();

      if (!storedToken) {
        if (isMounted.current) setLoading(false);
        return;
      }

      try {
        const response = await fetchCurrentUser();
        if (isMounted.current) {
          setUser(response.data.user);
          setToken(storedToken);
        }
      } catch {
        // Invalid, expired or unreachable — start from a clean slate.
        if (isMounted.current) clearSession();
      } finally {
        if (isMounted.current) setLoading(false);
      }
    }

    restoreSession();

    return () => {
      isMounted.current = false;
    };
  }, [clearSession]);

  const login = useCallback(async (credentials) => {
    const response = await loginRequest(credentials);
    const { token: issuedToken, user: authenticatedUser } = response.data;

    storeToken(issuedToken);
    setToken(issuedToken);
    setUser(authenticatedUser);

    return authenticatedUser;
  }, []);

  const logout = useCallback(async () => {
    try {
      await logoutRequest();
    } catch {
      // The server-side cookie may already be gone; the local session still goes.
    } finally {
      clearSession();
    }
  }, [clearSession]);

  const value = useMemo(
    () => ({
      user,
      token,
      isAuthenticated: Boolean(user),
      loading,
      login,
      logout
    }),
    [user, token, loading, login, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

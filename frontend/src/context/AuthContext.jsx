import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { Amplify } from "aws-amplify";
import { fetchAuthSession, signOut } from "aws-amplify/auth";
import { Hub } from "aws-amplify/utils";

Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: import.meta.env.VITE_USER_POOL_ID,
      userPoolClientId: import.meta.env.VITE_USER_POOL_CLIENT_ID,
    },
  },
});

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [idToken, setIdToken] = useState(null);
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const session = await fetchAuthSession();
      const token = session?.tokens?.idToken?.toString() || null;
      const payload = session?.tokens?.idToken?.payload || {};
      setIdToken(token);
      setUser(
        token
          ? {
              userId: payload.sub,
              email: payload.email,
              role: payload["custom:role"] || "",
              displayName: payload["custom:displayName"] || "",
            }
          : null
      );
    } catch {
      setIdToken(null);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();

    const unsubscribe = Hub.listen("auth", ({ payload }) => {
      switch (payload.event) {
        case "signedIn":
        case "tokenRefresh":
          refresh();
          break;
        case "signedOut":
        case "tokenRefresh_failure":
          setIdToken(null);
          setUser(null);
          setLoading(false);
          break;
        default:
          break;
      }
    });

    return unsubscribe;
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await signOut();
    } catch (err) {
      console.error("signOut failed", err);
    }
    setIdToken(null);
    setUser(null);
    window.location.href = "/login";
  }, []);

  return (
    <AuthContext.Provider value={{ idToken, user, loading, refresh, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

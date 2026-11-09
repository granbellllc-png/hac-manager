import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { apiClient } from '../api/client';

export interface AuthUser {
  readonly id: string;
  readonly username: string;
  readonly role: string;
  readonly totpEnabled?: boolean;
}

export interface AuthContextValue {
  readonly user: AuthUser | null;
  readonly loading: boolean;
  readonly setupNeeded: boolean;
  readonly error: string | null;
  readonly login: (
    username: string,
    password: string,
    totpCode?: string,
  ) => Promise<boolean>;
  readonly setup: (username: string, password: string) => Promise<boolean>;
  readonly logout: () => Promise<void>;
  readonly refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({
  children,
  initialUser,
  initialSetupNeeded,
}: {
  readonly children: ReactNode;
  readonly initialUser?: AuthUser | null;
  readonly initialSetupNeeded?: boolean;
}) {
  const [user, setUser] = useState<AuthUser | null>(initialUser ?? null);
  const [setupNeeded, setSetupNeeded] = useState(Boolean(initialSetupNeeded));
  const [loading, setLoading] = useState(initialUser === undefined);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { data, error: statusErr } =
        await apiClient.GET('/api/auth/status');
      if (statusErr || !data) {
        setUser(null);
        setError('Could not check your session.');
        return;
      }
      if (
        typeof data.setupNeeded !== 'boolean' ||
        (data.user !== null &&
          (!data.user ||
            typeof data.user.id !== 'string' ||
            typeof data.user.username !== 'string' ||
            !['admin', 'operator', 'viewer'].includes(data.user.role)))
      ) {
        throw new Error('Invalid authentication response.');
      }
      setSetupNeeded(Boolean(data.setupNeeded));
      setUser(data.user ? (data.user as AuthUser) : null);
      setError(null);
    } catch (err) {
      setUser(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (initialUser === undefined) {
      void refresh();
    }
  }, [refresh, initialUser]);

  const login = async (
    username: string,
    password: string,
    totpCode?: string,
  ): Promise<boolean> => {
    setError(null);
    try {
      const loginBody: {
        username: string;
        password: string;
        totpCode?: string;
        recoveryCode?: string;
      } = {
        username,
        password,
      };
      if (totpCode) {
        const code = totpCode.replace(/\s+/g, '');
        if (/^\d{6}$/.test(code)) loginBody.totpCode = code;
        else loginBody.recoveryCode = code;
      }

      const { data, error: apiErr } = await apiClient.POST('/api/auth/login', {
        body: loginBody,
      });

      if (apiErr || !data) {
        const msg =
          apiErr && typeof apiErr === 'object' && 'message' in apiErr
            ? String((apiErr as { message: string }).message)
            : 'Login failed';
        setError(msg);
        return false;
      }

      if (data.totpRequired) {
        setError(
          'Enter your two-factor authentication code or a recovery code.',
        );
        return false;
      }

      await refresh();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  };

  const setup = async (
    username: string,
    password: string,
  ): Promise<boolean> => {
    setError(null);
    try {
      const { data, error: apiErr } = await apiClient.POST('/api/auth/setup', {
        body: {
          username,
          password,
        },
      });

      if (apiErr || !data) {
        const msg =
          apiErr && typeof apiErr === 'object' && 'message' in apiErr
            ? String((apiErr as { message: string }).message)
            : 'Setup failed';
        setError(msg);
        return false;
      }

      setSetupNeeded(false);
      await refresh();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  };

  const logout = async () => {
    try {
      await apiClient.POST('/api/auth/logout');
    } finally {
      setUser(null);
      await refresh();
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        setupNeeded,
        error,
        login,
        setup,
        logout,
        refresh,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

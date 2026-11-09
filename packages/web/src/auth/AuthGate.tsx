import { useState, type ReactNode, type FormEvent } from 'react';
import { useAuth } from './auth-context';
import { Button } from '../components/ui/button';
import { ShieldCheck, LogIn, AlertCircle } from 'lucide-react';

export function AuthGate({ children }: { readonly children: ReactNode }) {
  const { user, loading, setupNeeded, error, login, setup } = useAuth();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center text-sm text-muted-foreground animate-pulse">
          Connecting to HAC Manager...
        </div>
      </div>
    );
  }

  if (user) {
    return <>{children}</>;
  }

  const handleSetup = async (e: FormEvent) => {
    e.preventDefault();
    setLocalError(null);

    if (username.trim().length < 3) {
      setLocalError('Username must be at least 3 characters.');
      return;
    }

    if (password.length < 8) {
      setLocalError('Password must be at least 8 characters.');
      return;
    }

    if (password !== confirmPassword) {
      setLocalError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    try {
      const ok = await setup(username.trim(), password);
      if (!ok) {
        setLocalError(error ?? 'Failed to initialize administrator account.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    setLocalError(null);

    if (!username.trim() || !password) {
      setLocalError('Username and password are required.');
      return;
    }

    setSubmitting(true);
    try {
      const ok = await login(
        username.trim(),
        password,
        totpCode.trim() || undefined,
      );
      if (!ok) {
        setLocalError(error ?? 'Invalid username or password.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (setupNeeded) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4 bg-background">
        <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-3 mb-4">
            <div className="rounded-full bg-primary/10 p-2 text-primary">
              <ShieldCheck className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-xl font-bold">Initial Setup</h1>
              <p className="text-xs text-muted-foreground">
                Create the initial administrator account.
              </p>
            </div>
          </div>

          {(localError || error) && (
            <div className="mb-4 flex items-center gap-2 rounded-md bg-destructive/15 p-3 text-xs text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{localError ?? error}</span>
            </div>
          )}

          <form onSubmit={handleSetup} className="space-y-4">
            <div>
              <label
                htmlFor="setup-username"
                className="block text-xs font-medium text-foreground mb-1"
              >
                Administrator Username
              </label>
              <input
                id="setup-username"
                type="text"
                autoComplete="username"
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                placeholder="admin"
              />
            </div>

            <div>
              <label
                htmlFor="setup-password"
                className="block text-xs font-medium text-foreground mb-1"
              >
                Password (min 8 characters)
              </label>
              <input
                id="setup-password"
                type="password"
                autoComplete="new-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>

            <div>
              <label
                htmlFor="setup-confirm-password"
                className="block text-xs font-medium text-foreground mb-1"
              >
                Confirm Password
              </label>
              <input
                id="setup-confirm-password"
                type="password"
                autoComplete="new-password"
                required
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>

            <Button type="submit" disabled={submitting} className="w-full mt-2">
              {submitting ? 'Creating Account...' : 'Create Admin & Sign In'}
            </Button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4 bg-background">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-sm">
        <div className="flex items-center gap-3 mb-4">
          <div className="rounded-full bg-primary/10 p-2 text-primary">
            <LogIn className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-xl font-bold">HAC Manager</h1>
            <p className="text-xs text-muted-foreground">
              Sign in to manage your Proxmox homelab.
            </p>
          </div>
        </div>

        {(localError || error) && (
          <div className="mb-4 flex items-center gap-2 rounded-md bg-destructive/15 p-3 text-xs text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{localError ?? error}</span>
          </div>
        )}

        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label
              htmlFor="login-username"
              className="block text-xs font-medium text-foreground mb-1"
            >
              Username
            </label>
            <input
              id="login-username"
              type="text"
              autoComplete="username"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              placeholder="admin"
            />
          </div>

          <div>
            <label
              htmlFor="login-password"
              className="block text-xs font-medium text-foreground mb-1"
            >
              Password
            </label>
            <input
              id="login-password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>

          <div>
            <label
              htmlFor="login-totp"
              className="block text-xs font-medium text-foreground mb-1"
            >
              2FA Code / Recovery Code{' '}
              <span className="text-muted-foreground">(if enabled)</span>
            </label>
            <input
              id="login-totp"
              type="text"
              autoComplete="one-time-code"
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              placeholder="123456"
            />
          </div>

          <Button type="submit" disabled={submitting} className="w-full mt-2">
            {submitting ? 'Signing in...' : 'Sign In'}
          </Button>
        </form>
      </div>
    </div>
  );
}

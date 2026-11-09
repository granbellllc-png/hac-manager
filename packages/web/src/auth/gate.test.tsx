import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from './auth-context';
import { AuthGate } from './AuthGate';

const auth = vi.hoisted(() => ({
  user: null as AuthUser | null,
  loading: false,
  setupNeeded: false,
  error: null as string | null,
  login: vi.fn(),
  setup: vi.fn(),
}));
vi.mock('./auth-context', () => ({ useAuth: () => auth }));
beforeEach(() => {
  auth.user = null;
  auth.loading = false;
  auth.setupNeeded = false;
  auth.error = null;
  auth.login.mockReset().mockResolvedValue(false);
  auth.setup.mockReset().mockResolvedValue(false);
});
function show() {
  return render(
    <AuthGate>
      <div>Authenticated content</div>
    </AuthGate>,
  );
}
function submit(label: string) {
  fireEvent.submit(screen.getByLabelText(label).closest('form')!);
}

describe('authentication form validation', () => {
  it('shows a connection state before authentication completes', () => {
    auth.loading = true;
    show();
    expect(
      screen.getByText('Connecting to HAC Manager...'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Authenticated content')).toBeNull();
  });

  it('shows authenticated content only with a user', () => {
    auth.user = { id: 'fixture', username: 'fixture', role: 'viewer' };
    show();
    expect(screen.getByText('Authenticated content')).toBeInTheDocument();
  });

  it('validates setup names, password length and matching confirmation before submitting', async () => {
    auth.setupNeeded = true;
    show();
    fireEvent.change(screen.getByLabelText('Administrator Username'), {
      target: { value: 'ab' },
    });
    submit('Administrator Username');
    expect(
      screen.getByText('Username must be at least 3 characters.'),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Administrator Username'), {
      target: { value: 'fixture' },
    });
    fireEvent.change(screen.getByLabelText('Password (min 8 characters)'), {
      target: { value: 'short' },
    });
    submit('Administrator Username');
    expect(
      screen.getByText('Password must be at least 8 characters.'),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Password (min 8 characters)'), {
      target: { value: 'fixture-password' },
    });
    fireEvent.change(screen.getByLabelText('Confirm Password'), {
      target: { value: 'mismatch' },
    });
    submit('Administrator Username');
    expect(screen.getByText('Passwords do not match.')).toBeInTheDocument();
    expect(auth.setup).not.toHaveBeenCalled();
  });

  it('shows setup submission state and leaves server errors visible', async () => {
    auth.setupNeeded = true;
    auth.error = 'fixture setup denied';
    let complete!: (ok: boolean) => void;
    auth.setup.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          complete = resolve;
        }),
    );
    show();
    expect(screen.getByText('fixture setup denied')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Password (min 8 characters)'), {
      target: { value: 'fixture-password' },
    });
    fireEvent.change(screen.getByLabelText('Confirm Password'), {
      target: { value: 'fixture-password' },
    });
    submit('Administrator Username');
    expect(
      screen.getByRole('button', { name: 'Creating Account...' }),
    ).toBeDisabled();
    complete(false);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Create Admin & Sign In' }),
      ).toBeEnabled(),
    );
    expect(screen.getByText('fixture setup denied')).toBeInTheDocument();
  });

  it('validates login fields and submits a trimmed second factor', async () => {
    show();
    fireEvent.change(screen.getByLabelText('Username'), {
      target: { value: ' ' },
    });
    submit('Username');
    expect(
      screen.getByText('Username and password are required.'),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Username'), {
      target: { value: ' fixture ' },
    });
    submit('Username');
    expect(auth.login).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'fixture-password' },
    });
    fireEvent.change(screen.getByLabelText(/2FA Code/), {
      target: { value: ' abcdef-123456 ' },
    });
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Sign In' }));
    expect(auth.login).toHaveBeenCalledWith(
      'fixture',
      'fixture-password',
      'abcdef-123456',
    );
  });

  it('renders a server login error and disables the pending submit button', async () => {
    auth.error = 'fixture login denied';
    let complete!: (ok: boolean) => void;
    auth.login.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          complete = resolve;
        }),
    );
    show();
    expect(screen.getByText('fixture login denied')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'fixture-password' },
    });
    submit('Username');
    expect(
      screen.getByRole('button', { name: 'Signing in...' }),
    ).toBeDisabled();
    complete(false);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Sign In' })).toBeEnabled(),
    );
  });
});

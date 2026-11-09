import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from './auth-context';
import { AuthGate } from './AuthGate';

function TestConsumer() {
  const { user, logout } = useAuth();
  return (
    <div>
      <div data-testid="user">{user?.username}</div>
      <button onClick={() => void logout()}>Logout</button>
    </div>
  );
}

describe('AuthGate & AuthProvider', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('renders initial setup form when setup is needed and allows admin creation', async () => {
    const user = userEvent.setup();

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((request: Request | string) => {
        const url = typeof request === 'string' ? request : request.url;
        const method = typeof request === 'string' ? 'GET' : request.method;

        if (url.includes('/api/auth/status')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                setupNeeded: true,
                user: null,
              }),
              { headers: { 'content-type': 'application/json' } },
            ),
          );
        }

        if (url.includes('/api/auth/setup') && method === 'POST') {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                message: 'Admin created',
                user: { id: 'admin-1', username: 'admin', role: 'admin' },
              }),
              {
                status: 201,
                headers: { 'content-type': 'application/json' },
              },
            ),
          );
        }

        return Promise.resolve(new Response(JSON.stringify({})));
      }),
    );

    render(
      <AuthProvider initialUser={null} initialSetupNeeded={true}>
        <AuthGate>
          <TestConsumer />
        </AuthGate>
      </AuthProvider>,
    );

    expect(screen.getByText('Initial Setup')).toBeInTheDocument();
    expect(screen.getByLabelText('Administrator Username')).toBeInTheDocument();

    await user.type(
      screen.getByLabelText('Password (min 8 characters)'),
      'SuperSecret123',
    );
    await user.type(
      screen.getByLabelText('Confirm Password'),
      'SuperSecret123',
    );

    // Re-mock status to return authenticated user after setup
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((request: Request | string) => {
        const url = typeof request === 'string' ? request : request.url;
        if (url.includes('/api/auth/status')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                setupNeeded: false,
                user: { id: 'admin-1', username: 'admin', role: 'admin' },
              }),
              { headers: { 'content-type': 'application/json' } },
            ),
          );
        }
        return Promise.resolve(new Response(JSON.stringify({})));
      }),
    );

    await user.click(
      screen.getByRole('button', { name: 'Create Admin & Sign In' }),
    );

    await waitFor(() => {
      expect(screen.getByTestId('user')).toHaveTextContent('admin');
    });
  });

  it('renders sign in form when setup is not needed and logs in successfully', async () => {
    const user = userEvent.setup();

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((request: Request | string) => {
        const url = typeof request === 'string' ? request : request.url;
        const method = typeof request === 'string' ? 'GET' : request.method;

        if (url.includes('/api/auth/status')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                setupNeeded: false,
                user: null,
              }),
              { headers: { 'content-type': 'application/json' } },
            ),
          );
        }

        if (url.includes('/api/auth/login') && method === 'POST') {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                message: 'Logged in',
                user: { id: 'admin-1', username: 'admin', role: 'admin' },
              }),
              {
                status: 200,
                headers: { 'content-type': 'application/json' },
              },
            ),
          );
        }

        return Promise.resolve(new Response(JSON.stringify({})));
      }),
    );

    render(
      <AuthProvider initialUser={null} initialSetupNeeded={false}>
        <AuthGate>
          <TestConsumer />
        </AuthGate>
      </AuthProvider>,
    );

    expect(
      screen.getByRole('heading', { name: 'HAC Manager' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeInTheDocument();

    await user.type(screen.getByLabelText('Password'), 'SuperSecret123');

    // Re-mock status to return authenticated user after login
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((request: Request | string) => {
        const url = typeof request === 'string' ? request : request.url;
        if (url.includes('/api/auth/status')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                setupNeeded: false,
                user: { id: 'admin-1', username: 'admin', role: 'admin' },
              }),
              { headers: { 'content-type': 'application/json' } },
            ),
          );
        }
        return Promise.resolve(new Response(JSON.stringify({})));
      }),
    );

    await user.click(screen.getByRole('button', { name: 'Sign In' }));

    await waitFor(() => {
      expect(screen.getByTestId('user')).toHaveTextContent('admin');
    });
  });
});

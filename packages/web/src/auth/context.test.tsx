import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from './auth-context';

const fixtureUser = { id: 'fixture', username: 'fixture-user', role: 'admin' };
const wrapper = ({ children }: { children: ReactNode }) => (
  <AuthProvider initialUser={null}>{children}</AuthProvider>
);
afterEach(() => vi.unstubAllGlobals());
function response(data: unknown, status = 200) {
  return Response.json(data, { status });
}

describe('authentication state from server responses', () => {
  it('loads the current session on mount in the same way in tests and production', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(async () =>
          response({ setupNeeded: false, user: fixtureUser }),
        ),
    );
    const { result } = renderHook(useAuth, {
      wrapper: ({ children }) => <AuthProvider>{children}</AuthProvider>,
    });
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.user).toEqual(fixtureUser);
  });

  it.each([
    {},
    { status: 'ok' },
    { setupNeeded: false },
    { setupNeeded: false, user: { ...fixtureUser, role: 'unknown' } },
    { setupNeeded: false, user: { ...fixtureUser, id: 1 } },
    { setupNeeded: false, user: { ...fixtureUser, username: null } },
  ])(
    'never manufactures an administrator from a malformed status response',
    async (data) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async () => response(data)),
      );
      const { result } = renderHook(useAuth, { wrapper });
      await act(() => result.current.refresh());
      expect(result.current.user).toBeNull();
      expect(result.current.error).toBe('Invalid authentication response.');
    },
  );

  it.each([new Error('fixture offline'), 'fixture offline'])(
    'reports status transport failures',
    async (error) => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error));
      const { result } = renderHook(useAuth, { wrapper });
      await act(() => result.current.refresh());
      expect(result.current.error).toBe('fixture offline');
      expect(result.current.user).toBeNull();
    },
  );

  it.each([401, 204])(
    'keeps unauthenticated state on an unsuccessful status response (%s)',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockImplementation(async () =>
            status === 204
              ? new Response(null, { status })
              : response({ message: 'fixture denied' }, status),
          ),
      );
      const { result } = renderHook(useAuth, { wrapper });
      await act(() => result.current.refresh());
      expect(result.current.error).toBe('Could not check your session.');
    },
  );

  it.each(['login', 'setup'] as const)(
    'reports %s API and transport errors',
    async (operation) => {
      const fetchFn = vi.fn();
      vi.stubGlobal('fetch', fetchFn);
      const { result } = renderHook(useAuth, { wrapper });
      for (const scenario of [
        {
          response: () => response({ message: 'fixture denied' }, 400),
          error: 'fixture denied',
        },
        {
          response: () => response('denied', 400),
          error: operation === 'login' ? 'Login failed' : 'Setup failed',
        },
        {
          response: () => new Response(null, { status: 204 }),
          error: operation === 'login' ? 'Login failed' : 'Setup failed',
        },
      ]) {
        fetchFn.mockImplementation(async () => scenario.response());
        await act(async () =>
          expect(
            await result.current[operation]('fixture', 'fixture-password'),
          ).toBe(false),
        );
        expect(result.current.error).toBe(scenario.error);
      }
      for (const failure of [new Error('fixture offline'), 'fixture offline']) {
        fetchFn.mockRejectedValue(failure);
        await act(async () =>
          expect(
            await result.current[operation]('fixture', 'fixture-password'),
          ).toBe(false),
        );
        expect(result.current.error).toBe('fixture offline');
      }
    },
  );

  it.each([
    ['123 456', { totpCode: '123456' }],
    ['abcdef-123456', { recoveryCode: 'abcdef-123456' }],
  ])('submits the appropriate second factor for %s', async (code, expected) => {
    let submitted: unknown;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (request: Request) => {
        if (request.url.endsWith('/login')) {
          submitted = await request.json();
          return response({ user: fixtureUser, message: 'ok' });
        }
        return response({ setupNeeded: false, user: fixtureUser });
      }),
    );
    const { result } = renderHook(useAuth, { wrapper });
    await act(async () =>
      expect(
        await result.current.login('fixture', 'fixture-password', String(code)),
      ).toBe(true),
    );
    expect(submitted).toEqual({
      username: 'fixture',
      password: 'fixture-password',
      ...expected,
    });
    expect(result.current.user).toEqual(fixtureUser);
  });

  it('asks for a second factor without treating the password-only response as a session', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(async () =>
          response({ message: 'required', totpRequired: true }),
        ),
    );
    const { result } = renderHook(useAuth, { wrapper });
    await act(async () =>
      expect(await result.current.login('fixture', 'fixture-password')).toBe(
        false,
      ),
    );
    expect(result.current.user).toBeNull();
    expect(result.current.error).toContain('two-factor authentication');
  });

  it('refreshes setup and logout state from the server', async () => {
    let signedIn = true;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (request: Request) => {
        if (request.url.endsWith('/logout')) signedIn = false;
        return request.url.endsWith('/status')
          ? response({
              setupNeeded: false,
              user: signedIn ? fixtureUser : null,
            })
          : response({ message: 'ok' });
      }),
    );
    const { result } = renderHook(useAuth, { wrapper });
    await act(async () =>
      expect(await result.current.setup('fixture', 'fixture-password')).toBe(
        true,
      ),
    );
    expect(result.current.user).toEqual(fixtureUser);
    await act(() => result.current.logout());
    expect(result.current.user).toBeNull();
  });

  it('requires an auth provider', () => {
    expect(() => renderHook(useAuth)).toThrow('AuthProvider');
  });
});

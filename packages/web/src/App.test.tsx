import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, RouteLoading } from './App';
import { navItems } from './nav';
import { ThemeProvider, useTheme } from './theme';
import {
  fixtureGuestDetail,
  fixtureGuests,
  fixtureHost,
} from '../fixtures/hosts';

async function renderApp(path = '/') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  await screen.findByRole('navigation', { name: 'Primary' });
  return view;
}

function mockApi(reply: () => Promise<Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (request: Request) => {
      if (request.url.endsWith('/api/auth/status'))
        return Response.json({
          setupNeeded: false,
          user: { id: 'fixture-admin', username: 'admin', role: 'admin' },
        });
      if (request.url.includes('/api/audit'))
        return Response.json({ items: [], total: 0, limit: 20, offset: 0 });
      return reply();
    }),
  );
}

function mockMatchMedia(dark: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches: dark,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.classList.remove('dark');
  mockMatchMedia(false);
  mockApi(async () => Response.json({ status: 'ok', service: 'HAC Manager' }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('application shell', () => {
  it('signs out through the authenticated header and returns to the login form', async () => {
    let signedIn = true;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (request: Request) => {
        if (request.url.endsWith('/api/auth/logout')) signedIn = false;
        if (request.url.endsWith('/api/auth/status'))
          return Response.json({
            setupNeeded: false,
            user: signedIn
              ? { id: 'fixture', username: 'fixture', role: 'admin' }
              : null,
          });
        return Response.json({ hosts: [], status: 'ok', message: 'ok' });
      }),
    );
    await renderApp();
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Sign out' }));
    expect(
      await screen.findByRole('button', { name: 'Sign In' }),
    ).toBeInTheDocument();
  });
  it('renders every planned module in the sidebar', async () => {
    await renderApp();
    const primary = screen.getByRole('navigation', { name: 'Primary' });
    for (const item of navItems) {
      expect(primary).toHaveTextContent(item.label);
    }
  });

  it('renders a placeholder page per route', async () => {
    await renderApp('/audit');
    expect(screen.getByRole('heading', { name: 'Audit' })).toBeInTheDocument();
  });

  it('renders a not-found page for unknown routes', async () => {
    await renderApp('/nope');
    expect(
      screen.getByRole('heading', { name: 'Not found' }),
    ).toBeInTheDocument();
  });

  it('renders the lazy resource list and guest detail routes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === '/api/auth/status')
          return Response.json({
            setupNeeded: false,
            user: { id: 'fixture-admin', username: 'admin', role: 'admin' },
          });
        if (path === '/api/health')
          return Response.json({ status: 'ok', service: 'HAC Manager' });
        if (path === '/api/inventory/guests')
          return Response.json({ guests: fixtureGuests });
        if (path === '/api/hosts')
          return Response.json({ hosts: [fixtureHost] });
        if (path === '/api/inventory/guests/fixture-host/112')
          return Response.json(fixtureGuestDetail);
        return Response.json({}, { status: 404 });
      }),
    );

    const resourcesView = await renderApp('/resources');
    expect(
      await screen.findByRole('heading', { name: 'Resources' }),
    ).toBeInTheDocument();
    resourcesView.unmount();

    await renderApp('/resources/fixture-host/112?type=lxc');
    expect(
      await screen.findByRole('heading', { name: 'Example LXC' }),
    ).toBeInTheDocument();
  });

  it('renders the lazy jobs route', async () => {
    class FixtureEventSource {
      public static readonly OPEN = 1;
      public readyState = FixtureEventSource.OPEN;
      public addEventListener() {}
      public close() {}
    }
    vi.stubGlobal('EventSource', FixtureEventSource);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === '/api/auth/status')
          return Response.json({
            setupNeeded: false,
            user: { id: 'fixture-admin', username: 'admin', role: 'admin' },
          });
        if (path === '/api/health')
          return Response.json({ status: 'ok', service: 'HAC Manager' });
        if (path === '/api/jobs') return Response.json({ jobs: [] });
        if (path === '/api/prompts') return Response.json({ prompts: [] });
        return Response.json({}, { status: 404 });
      }),
    );
    await renderApp('/jobs');
    expect(
      await screen.findByRole('heading', { name: 'Jobs & Queue' }),
    ).toBeVisible();
  });

  it('renders the route loading fallback', () => {
    render(<RouteLoading />);
    expect(screen.getByText('Loading page…')).toBeInTheDocument();
  });

  it('opens and closes the mobile drawer, closing on navigation', async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    const mobile = screen.getByRole('navigation', { name: 'Mobile' });
    await user.click(screen.getByRole('button', { name: 'Close navigation' }));
    expect(screen.queryByRole('navigation', { name: 'Mobile' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    await user.click(
      screen
        .getByRole('navigation', { name: 'Mobile' })
        .querySelector('a[href="/drift"]')!,
    );
    expect(mobile).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Drift' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    await user.click(
      screen.getByRole('button', { name: 'Close navigation overlay' }),
    );
    expect(screen.queryByRole('navigation', { name: 'Mobile' })).toBeNull();
  });

  it('toggles and persists the theme', async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(
      screen.getByRole('button', { name: 'Switch to dark theme' }),
    );
    expect(document.documentElement).toHaveClass('dark');
    expect(window.localStorage.getItem('hacm-theme')).toBe('dark');
    await user.click(
      screen.getByRole('button', { name: 'Switch to light theme' }),
    );
    expect(document.documentElement).not.toHaveClass('dark');
  });

  it('honours a stored or system theme preference', async () => {
    window.localStorage.setItem('hacm-theme', 'dark');
    await renderApp();
    expect(document.documentElement).toHaveClass('dark');
  });

  it('falls back to the system dark preference', async () => {
    mockMatchMedia(true);
    await renderApp();
    expect(document.documentElement).toHaveClass('dark');
  });

  it('requires a ThemeProvider for useTheme', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    function Probe() {
      useTheme();
      return null;
    }
    expect(() => render(<Probe />)).toThrow('ThemeProvider');
    spy.mockRestore();
  });
});

describe('server status', () => {
  it('shows online when the health endpoint answers', async () => {
    await renderApp();
    await waitFor(() => {
      expect(screen.getByText('API online')).toBeInTheDocument();
    });
  });

  it('shows offline when the health endpoint fails', async () => {
    mockApi(async () => {
      throw new Error('down');
    });
    await renderApp();
    await waitFor(() => {
      expect(screen.getByText('API offline')).toBeInTheDocument();
    });
  });

  it('shows offline for an error response', async () => {
    mockApi(async () => Response.json({ message: 'boom' }, { status: 500 }));
    await renderApp();
    await waitFor(() => {
      expect(screen.getByText('API offline')).toBeInTheDocument();
    });
  });
});

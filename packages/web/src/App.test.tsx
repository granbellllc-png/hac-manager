import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { navItems } from './nav';
import { ThemeProvider, useTheme } from './theme';

function renderApp(path = '/') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

function mockMatchMedia(dark: boolean) {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: dark }));
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.classList.remove('dark');
  mockMatchMedia(false);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'ok', service: 'HAC Manager' }), {
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('application shell', () => {
  it('renders every planned module in the sidebar', () => {
    renderApp();
    const primary = screen.getByRole('navigation', { name: 'Primary' });
    for (const item of navItems) {
      expect(primary).toHaveTextContent(item.label);
    }
  });

  it('renders a placeholder page per route', () => {
    renderApp('/audit');
    expect(screen.getByRole('heading', { name: 'Audit' })).toBeInTheDocument();
  });

  it('renders a not-found page for unknown routes', () => {
    renderApp('/nope');
    expect(
      screen.getByRole('heading', { name: 'Not found' }),
    ).toBeInTheDocument();
  });

  it('opens and closes the mobile drawer, closing on navigation', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    const mobile = screen.getByRole('navigation', { name: 'Mobile' });
    await user.click(screen.getByRole('button', { name: 'Close navigation' }));
    expect(screen.queryByRole('navigation', { name: 'Mobile' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    await user.click(
      screen
        .getByRole('navigation', { name: 'Mobile' })
        .querySelector('a[href="/jobs"]')!,
    );
    expect(mobile).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Jobs' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    await user.click(
      screen.getByRole('button', { name: 'Close navigation overlay' }),
    );
    expect(screen.queryByRole('navigation', { name: 'Mobile' })).toBeNull();
  });

  it('toggles and persists the theme', async () => {
    const user = userEvent.setup();
    renderApp();
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

  it('honours a stored or system theme preference', () => {
    window.localStorage.setItem('hacm-theme', 'dark');
    renderApp();
    expect(document.documentElement).toHaveClass('dark');
  });

  it('falls back to the system dark preference', () => {
    mockMatchMedia(true);
    renderApp();
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
    renderApp();
    await waitFor(() => {
      expect(screen.getByText('API online')).toBeInTheDocument();
    });
  });

  it('shows offline when the health endpoint fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    renderApp();
    await waitFor(() => {
      expect(screen.getByText('API offline')).toBeInTheDocument();
    });
  });

  it('shows offline for an error response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: 'boom' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    renderApp();
    await waitFor(() => {
      expect(screen.getByText('API offline')).toBeInTheDocument();
    });
  });
});

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fixtureHost,
  fixtureHostDetail,
  fixtureProbe,
} from '../../fixtures/hosts';
import { HostsPage } from './hosts';
import { HostDetailPage } from './host-detail';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function Location() {
  const location = useLocation();
  return (
    <div>
      {location.pathname}
      {location.search}
    </div>
  );
}
function renderHosts() {
  return render(
    <MemoryRouter>
      <Routes>
        <Route path="/" element={<HostsPage />} />
        <Route path="/hosts/:id" element={<Location />} />
      </Routes>
    </MemoryRouter>,
  );
}
function renderDetail() {
  return render(
    <MemoryRouter initialEntries={['/hosts/fixture-host']}>
      <Routes>
        <Route path="/hosts/:id" element={<HostDetailPage />} />
        <Route path="/" element={<div>Hosts destination</div>} />
        <Route path="/resources" element={<Location />} />
      </Routes>
    </MemoryRouter>,
  );
}
function installApi(
  override?: (request: Request) => Promise<Response> | undefined,
) {
  const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const request = input as Request;
    const result = override?.(request);
    if (result) return result;
    const path = new URL(request.url).pathname;
    if (path === '/api/hosts') return Response.json({ hosts: [fixtureHost] });
    if (path === '/api/inventory/hosts') return Response.json({ hosts: [] });
    if (path.endsWith('/test-connection'))
      return Response.json({
        ok: true,
        ssh: { ok: true, status: 'connected' },
        api: { ok: true, status: 'connected' },
      });
    if (path.endsWith('/probe')) return Response.json(fixtureProbe);
    if (path.endsWith('/sync'))
      return Response.json({ synced: 1, removed: 0, issues: [] });
    return Response.json({ host: fixtureHostDetail });
  });
  vi.stubGlobal('fetch', fetchFn);
  return fetchFn;
}

describe('host overview states and actions', () => {
  it.each([
    'healthy',
    'online',
    'connected',
    'ok',
    'degraded',
    'unreachable',
    'error',
    'failed',
    'unknown',
    '',
  ])(
    'renders %s status with degraded channels and vault states',
    async (status) => {
      installApi((request) =>
        new URL(request.url).pathname === '/api/hosts'
          ? Promise.resolve(
              Response.json({
                hosts: [
                  {
                    ...fixtureHost,
                    status,
                    runtime: {
                      ...fixtureHost.runtime,
                      ssh: { status: '' },
                      api: { configured: true, status: '' },
                      vault: { status: 'locked' },
                      queue: { status: '' },
                      issues: ['fixture capability warning'],
                    },
                  },
                ],
              }),
            )
          : undefined,
      );
      renderHosts();
      await screen.findByRole('heading', { name: 'Fixture Host' });
      expect(
        screen.getByText('fixture capability warning'),
      ).toBeInTheDocument();
      expect(screen.getByText('Locked')).toBeInTheDocument();
      expect(screen.getByText('Offline')).toBeInTheDocument();
    },
  );

  it('shows an empty state and opens/closes add-host instructions', async () => {
    installApi((request) =>
      new URL(request.url).pathname === '/api/hosts'
        ? Promise.resolve(Response.json({ hosts: [] }))
        : undefined,
    );
    renderHosts();
    await screen.findByText('No hosts found');
    const user = userEvent.setup();
    await user.click(
      screen.getByRole('button', { name: 'Show Add Host Instructions' }),
    );
    expect(screen.getByText('How to Add a Host')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByText('How to Add a Host')).toBeNull();
  });

  it('copies the YAML example and clears the copy indicator', async () => {
    installApi();
    const user = userEvent.setup();
    const write = vi
      .spyOn(navigator.clipboard, 'writeText')
      .mockResolvedValue();
    renderHosts();
    await screen.findByRole('heading', { name: 'Fixture Host' });
    await user.click(screen.getByRole('button', { name: 'Add Host' }));
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining('host: 192.0.2.52'),
    );
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });

  it('reports a denied clipboard write', async () => {
    installApi();
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(
      new Error('fixture clipboard denied'),
    );
    renderHosts();
    await screen.findByRole('heading', { name: 'Fixture Host' });
    await user.click(screen.getByRole('button', { name: 'Add Host' }));
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(
      await screen.findByText('Could not copy YAML to the clipboard.'),
    ).toBeInTheDocument();
  });

  it.each(['http', 'network', 'non-error'] as const)(
    'reports %s registry errors',
    async (mode) => {
      installApi(() =>
        mode === 'http'
          ? Promise.resolve(Response.json({}, { status: 500 }))
          : Promise.reject(
              mode === 'network'
                ? new Error('fixture offline')
                : 'fixture offline',
            ),
      );
      renderHosts();
      expect(
        await screen.findByText(
          mode === 'http' ? 'Failed to load host registry.' : 'fixture offline',
        ),
      ).toBeInTheDocument();
    },
  );

  it('resyncs host data and follows the host detail link', async () => {
    const fetchFn = installApi((request) =>
      request.url.endsWith('/api/inventory/hosts')
        ? Promise.resolve(Response.json({}))
        : undefined,
    );
    const user = userEvent.setup();
    renderHosts();
    await screen.findByRole('heading', { name: 'Fixture Host' });
    await user.click(screen.getByRole('button', { name: 'Resync YAML' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Resync YAML' })).toBeEnabled(),
    );
    expect(
      fetchFn.mock.calls.some(([request]) =>
        (request as Request).url.endsWith('/sync'),
      ),
    ).toBe(true);
    await user.click(screen.getByRole('button', { name: 'View Details' }));
    expect(screen.getByText('/hosts/fixture-host')).toBeInTheDocument();
  });

  it.each(['http', 'network'] as const)(
    'reports %s resync failures',
    async (mode) => {
      installApi((request) =>
        request.url.endsWith('/sync')
          ? mode === 'http'
            ? Promise.resolve(Response.json({}, { status: 500 }))
            : Promise.reject(new Error('fixture offline'))
          : undefined,
      );
      renderHosts();
      await screen.findByRole('heading', { name: 'Fixture Host' });
      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: 'Resync YAML' }));
      expect(
        await screen.findByText('Failed to resync host registry.'),
      ).toBeInTheDocument();
    },
  );

  it.each(['http', 'network', 'channels'] as const)(
    'reports %s connection test failures',
    async (mode) => {
      installApi((request) =>
        request.url.endsWith('/test-connection')
          ? mode === 'http'
            ? Promise.resolve(Response.json({}, { status: 500 }))
            : mode === 'network'
              ? Promise.reject(new Error('fixture offline'))
              : Promise.resolve(
                  Response.json({
                    ok: false,
                    ssh: { ok: false, status: 'error' },
                  }),
                )
          : undefined,
      );
      renderHosts();
      await screen.findByRole('heading', { name: 'Fixture Host' });
      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: 'Test Connection' }));
      expect(await screen.findByText('FAILED')).toBeInTheDocument();
    },
  );

  it('handles unconfigured API and vault state and connection results without latency', async () => {
    installApi((request) =>
      new URL(request.url).pathname === '/api/hosts'
        ? Promise.resolve(
            Response.json({
              hosts: [
                {
                  ...fixtureHost,
                  runtime: {
                    ...fixtureHost.runtime,
                    api: { configured: false, status: 'not_configured' },
                    vault: { status: 'not_configured' },
                  },
                },
              ],
            }),
          )
        : undefined,
    );
    renderHosts();
    await screen.findByRole('heading', { name: 'Fixture Host' });
    expect(screen.getByText('Not Configured')).toBeInTheDocument();
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Test Connection' }));
    expect(await screen.findByText(/SSH: OK \(0ms\)/)).toBeInTheDocument();
  });

  it('shows the persisted last check and refreshes host cards after testing', async () => {
    const fetchFn = installApi((request) => {
      if (
        request.method === 'GET' &&
        new URL(request.url).pathname === '/api/hosts'
      ) {
        return Promise.resolve(
          Response.json({
            hosts: [
              {
                ...fixtureHost,
                runtime: {
                  ...fixtureHost.runtime,
                  ssh: {
                    status: 'connected',
                    lastCheckedAt: '2026-01-02T03:04:05.000Z',
                  },
                },
              },
            ],
          }),
        );
      }
      return undefined;
    });
    renderHosts();
    expect(await screen.findByText(/Last checked/)).toBeVisible();
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Test Connection' }));
    await waitFor(() =>
      expect(
        fetchFn.mock.calls.filter(([request]) => {
          const req = request as Request;
          return (
            req.method === 'GET' && new URL(req.url).pathname === '/api/hosts'
          );
        }).length,
      ).toBeGreaterThanOrEqual(2),
    );
  });
});

describe('host detail variants', () => {
  it('renders SSH-only configuration, cluster warnings, storage sizes and guest navigation', async () => {
    installApi();
    renderDetail();
    await screen.findByRole('heading', { name: 'Fixture Host' });
    expect(screen.getByText('Not configured')).toBeInTheDocument();
    expect(
      await screen.findByText(/Cluster Membership Detected/),
    ).toHaveTextContent('Proxmox Cluster');
    expect(screen.getByText('2.0 TB')).toBeInTheDocument();
    expect(screen.getByText('N/A')).toBeInTheDocument();
    expect(screen.getByText('Missing')).toBeInTheDocument();
    expect(screen.getByText('Yes')).toBeInTheDocument();
    await userEvent
      .setup()
      .click(
        screen.getByRole('button', { name: 'View Guests on Fixture Host' }),
      );
    expect(
      screen.getByText('/resources?hostId=fixture-host'),
    ).toBeInTheDocument();
  });

  it('runs probes and connection tests, preserving a usable page on errors', async () => {
    installApi();
    renderDetail();
    await screen.findByRole('heading', { name: 'Fixture Host' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Run Probe' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Run Probe' })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: 'Test Connection' }));
    expect(
      await screen.findByText('Connection Test Results'),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Connected (0ms)')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Back to Hosts' }));
    expect(screen.getByText('Hosts destination')).toBeInTheDocument();
  });

  it('shows saved runtime status, probe guidance, and reloads detail after testing', async () => {
    const fetchFn = installApi((request) => {
      if (
        request.method === 'GET' &&
        new URL(request.url).pathname === '/api/hosts/fixture-host'
      ) {
        return Promise.resolve(
          Response.json({
            host: {
              ...fixtureHostDetail,
              runtime: {
                ...fixtureHostDetail.runtime,
                ssh: {
                  status: 'connected',
                  lastCheckedAt: '2026-01-02T03:04:05.000Z',
                },
              },
            },
          }),
        );
      }
      return undefined;
    });
    renderDetail();
    await screen.findByRole('heading', { name: 'Fixture Host' });
    expect(screen.getByText('Saved runtime status')).toBeVisible();
    expect(screen.getByText(/Last checked/)).toBeVisible();
    expect(
      screen.getByText(/Run Probe refreshes host capabilities/),
    ).toBeVisible();

    const detailGets = () =>
      fetchFn.mock.calls.filter(([request]) => {
        const req = request as Request;
        return (
          req.method === 'GET' &&
          new URL(req.url).pathname === '/api/hosts/fixture-host'
        );
      }).length;
    const before = detailGets();

    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Test Connection' }));
    await waitFor(() => expect(detailGets()).toBeGreaterThan(before));
  });

  it('reports a missing host id without calling the API', async () => {
    const fetchFn = installApi();
    render(
      <MemoryRouter initialEntries={['/hosts']}>
        <Routes>
          <Route path="/hosts" element={<HostDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('Host not found.')).toBeVisible();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('renders saved channel errors and configured API details', async () => {
    installApi((request) => {
      if (
        request.method === 'GET' &&
        new URL(request.url).pathname === '/api/hosts/fixture-host'
      ) {
        return Promise.resolve(
          Response.json({
            host: {
              ...fixtureHostDetail,
              connection: {
                ssh: fixtureHostDetail.connection.ssh,
                api: {
                  configured: true,
                  url: 'https://192.0.2.10:8006',
                  tokenId: 'root@pam!fixture',
                  fingerprint: 'AA:BB',
                },
              },
              runtime: {
                ...fixtureHostDetail.runtime,
                ssh: {
                  status: 'error',
                  error: 'fixture ssh error',
                  lastCheckedAt: '2026-01-02T03:04:05.000Z',
                },
                api: {
                  configured: true,
                  status: 'error',
                  error: 'fixture api error',
                  lastCheckedAt: '2026-01-02T03:04:05.000Z',
                },
              },
            },
          }),
        );
      }
      return undefined;
    });
    renderDetail();
    await screen.findByRole('heading', { name: 'Fixture Host' });
    expect(screen.getByText('SSH: fixture ssh error')).toBeVisible();
    expect(screen.getByText('API: fixture api error')).toBeVisible();
    expect(screen.getByText(/TLS Fingerprint: AA:BB/)).toBeVisible();
  });

  it.each(['http', 'network'] as const)(
    'reports %s action failures without discarding host detail',
    async (mode) => {
      installApi((request) =>
        request.method === 'POST'
          ? mode === 'http'
            ? Promise.resolve(Response.json({}, { status: 500 }))
            : Promise.reject(new Error('fixture offline'))
          : undefined,
      );
      renderDetail();
      await screen.findByRole('heading', { name: 'Fixture Host' });
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Run Probe' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Unable to probe host capabilities.',
      );
      await user.click(screen.getByRole('button', { name: 'Test Connection' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Unable to test the host connection.',
      );
      expect(
        screen.getByRole('heading', { name: 'Fixture Host' }),
      ).toBeInTheDocument();
    },
  );

  it.each(['http', 'network', 'non-error', 'missing'] as const)(
    'reports %s host detail errors',
    async (mode) => {
      installApi(() =>
        mode === 'http'
          ? Promise.resolve(Response.json({}, { status: 404 }))
          : mode === 'missing'
            ? Promise.resolve(Response.json({ host: null }))
            : Promise.reject(
                mode === 'network'
                  ? new Error('fixture offline')
                  : 'fixture offline',
              ),
      );
      renderDetail();
      await screen.findByRole('button', { name: 'Back to Hosts' });
      expect(
        screen.getByText(
          mode === 'http'
            ? 'Host not found or access denied.'
            : mode === 'missing'
              ? 'Host not found'
              : 'fixture offline',
        ),
      ).toBeInTheDocument();
      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: 'Back to Hosts' }));
      expect(screen.getByText('Hosts destination')).toBeInTheDocument();
    },
  );

  it.each(['http', 'network'] as const)(
    'renders a host when the optional initial probe fails by %s',
    async (mode) => {
      installApi((request) =>
        request.url.endsWith('/probe')
          ? mode === 'http'
            ? Promise.resolve(Response.json({}, { status: 404 }))
            : Promise.reject(new Error('fixture probe missing'))
          : undefined,
      );
      renderDetail();
      expect(
        await screen.findByRole('heading', { name: 'Fixture Host' }),
      ).toBeInTheDocument();
      expect(
        screen.queryByText('Host Capabilities & Storage Pools'),
      ).toBeNull();
    },
  );

  it.each([false, true])(
    'renders failed channels with explicit errors: %s',
    async (withErrors) => {
      installApi((request) =>
        request.url.endsWith('/test-connection')
          ? Promise.resolve(
              Response.json({
                ok: false,
                ssh: {
                  ok: false,
                  status: 'error',
                  ...(withErrors ? { error: 'fixture ssh failure' } : {}),
                },
                ...(withErrors
                  ? {
                      api: {
                        ok: false,
                        status: 'error',
                        error: 'fixture api failure',
                      },
                    }
                  : {}),
              }),
            )
          : undefined,
      );
      renderDetail();
      await screen.findByRole('heading', { name: 'Fixture Host' });
      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: 'Test Connection' }));
      expect(await screen.findByText('FAILED')).toBeInTheDocument();
      expect(
        screen.getByText(
          withErrors ? 'fixture api failure' : 'Not configured / Failed',
        ),
      ).toBeInTheDocument();
    },
  );
});

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { HostsPage } from './hosts';
import { HostDetailPage } from './host-detail';

const mockHostsData = {
  hosts: [
    {
      id: 'pve-01',
      name: 'Proxmox Main',
      type: 'proxmox',
      index: 1,
      status: 'healthy',
      runtime: {
        overall: 'healthy',
        ssh: { status: 'connected' },
        api: { configured: true, status: 'connected' },
        vault: { status: 'unlocked' },
        queue: { status: 'idle' },
        issues: [],
      },
      updatedAt: new Date().toISOString(),
    },
  ],
};

const mockInventoryHostsData = {
  hosts: [
    {
      hostId: 'pve-01',
      name: 'Proxmox Main',
      status: 'online',
      guestCount: 3,
      channels: {
        ssh: { ok: true, status: 'connected' },
        api: { ok: true, status: 'connected' },
      },
      lastRefreshedAt: new Date().toISOString(),
    },
  ],
};

const mockHostDetailData = {
  host: {
    id: 'pve-01',
    name: 'Proxmox Main',
    type: 'proxmox',
    index: 1,
    status: 'healthy',
    runtime: {
      overall: 'healthy',
      ssh: { status: 'connected' },
      api: { configured: true, status: 'connected' },
      vault: { status: 'unlocked' },
      queue: { status: 'idle' },
      issues: [],
    },
    connection: {
      ssh: {
        host: '192.168.1.10',
        port: 22,
        username: 'root',
        fingerprint: 'SHA256:abc123ssh',
        authMethod: 'key',
      },
      api: {
        configured: true,
        url: 'https://192.168.1.10:8006',
        tokenId: 'root@pam!hacm',
        fingerprint: 'SHA256:tls123',
      },
    },
    ignoredGuestsCount: 0,
    defaults: {
      deployment: 'hosts/pve-01/default-deployment.yaml',
      filemappings: 'hosts/pve-01/default-filemappings.yaml',
    },
  },
};

const mockProbeData = {
  hostId: 'pve-01',
  pveVersion: 'pve-manager/8.2.4/e817e4bc94a670e8',
  isCluster: false,
  storages: [
    {
      name: 'local-lvm',
      type: 'lvmthin',
      content: ['images', 'rootdir'],
      total: 1000 * 1024 * 1024 * 1024,
      used: 200 * 1024 * 1024 * 1024,
      avail: 800 * 1024 * 1024 * 1024,
      shared: false,
    },
  ],
  tools: {
    setfacl: true,
    rsync: true,
    restic: true,
    nsenter: true,
  },
  warnings: [],
  probedAt: new Date().toISOString(),
};

describe('Hosts UI components', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation((req: Request | string, init?: RequestInit) => {
          const url = typeof req === 'string' ? req : req.url;
          const method = init?.method ?? 'GET';

          if (url.endsWith('/api/hosts') && method === 'GET') {
            return Promise.resolve(
              new Response(JSON.stringify(mockHostsData), {
                headers: { 'content-type': 'application/json' },
              }),
            );
          }

          if (url.endsWith('/api/inventory/hosts') && method === 'GET') {
            return Promise.resolve(
              new Response(JSON.stringify(mockInventoryHostsData), {
                headers: { 'content-type': 'application/json' },
              }),
            );
          }

          if (url.endsWith('/api/hosts/pve-01') && method === 'GET') {
            return Promise.resolve(
              new Response(JSON.stringify(mockHostDetailData), {
                headers: { 'content-type': 'application/json' },
              }),
            );
          }

          if (url.endsWith('/api/hosts/pve-01/probe')) {
            return Promise.resolve(
              new Response(JSON.stringify(mockProbeData), {
                headers: { 'content-type': 'application/json' },
              }),
            );
          }

          if (url.endsWith('/api/hosts/pve-01/test-connection')) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  ok: true,
                  ssh: { ok: true, status: 'connected', latencyMs: 15 },
                  api: { ok: true, status: 'connected', latencyMs: 25 },
                }),
                { headers: { 'content-type': 'application/json' } },
              ),
            );
          }

          return Promise.resolve(new Response(JSON.stringify({})));
        }),
    );
  });

  it('renders hosts overview, displays per-channel status, and toggles add-host guidance', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <HostsPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: 'Hosts' })).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('Proxmox Main')).toBeInTheDocument();
    });

    expect(screen.getByText('idx:1')).toBeInTheDocument();
    expect(screen.getByText('Live Guests:')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();

    // Toggle add host guidance
    const addHostBtn = screen.getByRole('button', { name: /Add Host/i });
    await user.click(addHostBtn);
    expect(screen.getByText(/How to Add a Host/i)).toBeInTheDocument();
    expect(
      screen.getByText(/hosts\/<host-id>\/host\.yaml/i),
    ).toBeInTheDocument();
  });

  it('tests connection from overview card', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <HostsPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Proxmox Main')).toBeInTheDocument();
    });

    const testBtn = screen.getByRole('button', { name: 'Test Connection' });
    await user.click(testBtn);

    await waitFor(() => {
      expect(screen.getByText('OK')).toBeInTheDocument();
    });
  });

  it('renders host detail page with connection and capability probe', async () => {
    render(
      <MemoryRouter initialEntries={['/hosts/pve-01']}>
        <Routes>
          <Route path="/hosts/:id" element={<HostDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Proxmox Main' }),
      ).toBeInTheDocument();
    });

    expect(screen.getByText(/192.168.1.10:22/)).toBeInTheDocument();
    expect(screen.getByText(/root@pam!hacm/)).toBeInTheDocument();
    expect(screen.getByText(/local-lvm/)).toBeInTheDocument();
    expect(screen.getByText('800.0 GB')).toBeInTheDocument();
    expect(screen.getAllByText('Available').length).toBeGreaterThan(0);
  });
});

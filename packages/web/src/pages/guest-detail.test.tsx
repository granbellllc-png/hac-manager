import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureGuestDetail, fixtureGuests } from '../../fixtures/hosts';
import {
  formatGuestBytes,
  formatGuestConfigValue,
  formatGuestUptime,
  GuestDetailPage,
  isTerminalJobEvent,
} from './guest-detail';
import { AuthProvider } from '../auth/auth-context';

vi.mock('../components/guest-yaml-editor', () => ({
  GuestYamlEditor: ({
    snapshot,
    onSaved,
    onCancel,
  }: {
    snapshot: {
      relativePath: string;
      rawYaml: string;
      hash: string;
      issues: readonly unknown[];
    };
    onSaved: (value: {
      relativePath: string;
      rawYaml: string;
      hash: string;
      config: Record<string, unknown>;
      issues: readonly never[];
    }) => void;
    onCancel: () => void;
  }) => (
    <div>
      <p>Mock YAML editor</p>
      <button
        type="button"
        onClick={() =>
          onSaved({
            relativePath: snapshot.relativePath,
            rawYaml: snapshot.rawYaml.replace('ram: 1024', 'ram: 2048'),
            hash: 'b'.repeat(64),
            config: { ram: 2048 },
            issues: [],
          })
        }
      >
        Mock save
      </button>
      <button type="button" onClick={onCancel}>
        Mock cancel
      </button>
    </div>
  ),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderDetail(
  path = '/resources/fixture-host/112?type=lxc',
  role = 'admin',
) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider initialUser={{ id: role, username: role, role }}>
        <Routes>
          <Route
            path="/resources/:hostId/:vmid"
            element={<GuestDetailPage />}
          />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

function installDetailApi(
  response: unknown = fixtureGuestDetail,
  failure?: 'http' | 'network' | 'non-error',
) {
  const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => {
    if (failure === 'http') return Response.json({}, { status: 404 });
    if (failure === 'network') throw new Error('fixture offline');
    if (failure === 'non-error') throw 'fixture offline';
    return Response.json(response);
  });
  vi.stubGlobal('fetch', fetchFn);
  return fetchFn;
}

const orphanDetail = {
  summary: {
    ...fixtureGuests[1],
    maxcpu: undefined,
    maxmem: undefined,
    mem: undefined,
    uptime: 3600,
  },
  rawConfig: '',
  canonicalConfig: {
    id: 212,
    name: 'Unmanaged VM',
    type: 'vm',
    cpu: 4,
    ram: 4096,
    disks: [],
    network: [],
  },
  source: 'api',
  configuration: { status: 'orphan' },
};

const ignoredDetail = {
  ...orphanDetail,
  configuration: { status: 'ignored' as const },
};

function installIgnoreApi(mode?: 'http' | 'network' | 'non-error') {
  let currentDetail: unknown = orphanDetail;
  const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const request = input as Request;
    const path = new URL(request.url).pathname;
    if (request.method === 'POST' && path.endsWith('/ignore')) {
      if (mode === 'network') throw new Error('fixture offline');
      if (mode === 'non-error') throw 'fixture offline';
      if (mode === 'http') {
        return Response.json({ message: 'ignore denied' }, { status: 409 });
      }
      currentDetail = ignoredDetail;
      return Response.json({
        ignored: true,
        status: 'ignored',
        dryRun: false,
        changed: true,
        replaced: false,
        relativeFile: 'hosts/fixture-host/host.yaml',
      });
    }
    return Response.json(currentDetail);
  });
  vi.stubGlobal('fetch', fetchFn);
  return fetchFn;
}

class FakeEventSource {
  public static readonly instances: FakeEventSource[] = [];
  public static readonly OPEN = 1;
  public readyState = 1;
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  public constructor(public readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  public addEventListener(type: string, listener: (event: Event) => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  public close() {}

  public emit(type: string, data: unknown) {
    const event = { data: JSON.stringify(data) } as MessageEvent<string>;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function installOrphanApi(mode?: 'plan-fail' | 'apply-fail' | 'network') {
  let detailCalls = 0;
  const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const request = input as Request;
    const path = new URL(request.url).pathname;
    if (request.method === 'POST' && path === '/api/plans/guest-import') {
      if (mode === 'network') throw new Error('fixture offline');
      if (mode === 'plan-fail') {
        return Response.json({ message: 'plan denied' }, { status: 409 });
      }
      return Response.json({ id: 'plan-import' }, { status: 201 });
    }
    if (request.method === 'POST' && path.endsWith('/apply')) {
      if (mode === 'network') throw new Error('fixture offline');
      if (mode === 'apply-fail') {
        return Response.json({ message: 'apply denied' }, { status: 409 });
      }
      return Response.json(
        {
          plan: { id: 'plan-import', status: 'applying' },
          job: { id: 'job-import' },
        },
        { status: 202 },
      );
    }
    detailCalls += 1;
    return Response.json(orphanDetail);
  });
  vi.stubGlobal('fetch', fetchFn);
  return { fetchFn, detailCalls: () => detailCalls };
}

describe('guest detail helpers', () => {
  it('formats resource values and tagged configuration safely', () => {
    expect(formatGuestBytes(undefined)).toBe('Not reported');
    expect(formatGuestBytes(1024 ** 2)).toBe('1 MB');
    expect(formatGuestUptime(undefined)).toBe('Not reported');
    expect(formatGuestUptime(3600)).toBe('1h');
    expect(formatGuestUptime(90_000)).toBe('1d 1h');
    expect(formatGuestConfigValue(undefined)).toBe('Not set');
    expect(formatGuestConfigValue([1, 2])).toBe('2 configured');
    expect(
      formatGuestConfigValue({ tag: 'expr', value: 'host.index + 1' }),
    ).toBe('!expr host.index + 1');
    expect(formatGuestConfigValue({ tag: 'secret' })).toBe('!secret');
    expect(formatGuestConfigValue({ nested: true })).toBe('{"nested":true}');
    expect(formatGuestConfigValue(false)).toBe('false');
  });

  it('detects only terminal job statuses safely', () => {
    expect(isTerminalJobEvent(null)).toBe(false);
    expect(isTerminalJobEvent('completed')).toBe(false);
    expect(isTerminalJobEvent({ status: 1 })).toBe(false);
    expect(isTerminalJobEvent({ status: 'running' })).toBe(false);
    expect(isTerminalJobEvent({ status: 'completed' })).toBe(true);
    expect(isTerminalJobEvent({ status: 'failed' })).toBe(true);
  });
});

describe('GuestDetailPage', () => {
  it('shows live/configured comparison and byte-preserved YAML in CodeMirror', async () => {
    const response = {
      ...fixtureGuestDetail,
      configuration: {
        ...fixtureGuestDetail.configuration,
        config: {
          ...fixtureGuestDetail.configuration.config,
          protection: { nested: true },
        },
        issues: [
          {
            path: 'network.0.ip',
            code: 'custom',
            message: 'Fixture warning',
          },
        ],
      },
    };
    const fetchFn = installDetailApi(response);
    renderDetail();

    expect(
      await screen.findByRole('heading', { name: 'Example LXC' }),
    ).toBeVisible();
    expect(screen.getByText('Uptime 1d 1h')).toBeVisible();
    expect(screen.getByText('17% current usage')).toBeVisible();
    expect(screen.getByText(/Fixture warning/)).toBeVisible();
    expect(screen.getAllByText('{"nested":true}')).toHaveLength(2);
    expect(screen.getByText('pct config')).toBeVisible();
    expect(screen.getByText(/not the HAC Manager/)).toBeVisible();
    const yaml = await screen.findByLabelText('Example LXC deployment YAML');
    expect(yaml).toHaveTextContent('Fixture comment must remain visible');
    expect(yaml).toHaveTextContent('host.index + 1');
    const request = fetchFn.mock.calls[0]?.[0] as Request;
    expect(new URL(request.url).searchParams.get('type')).toBe('lxc');
  });

  it('queues a storage invariant check and tracks its job', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    FakeEventSource.instances.length = 0;
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const request = input as Request;
      const path = new URL(request.url).pathname;
      if (request.method === 'POST' && path.endsWith('/storage/check')) {
        return Response.json(
          {
            job: {
              id: 'job-storage',
              hostId: 'fixture-host',
              vmid: 112,
              lane: 'guest',
              type: 'guest.storage.invariant',
              reason: 'manual',
              status: 'queued',
              priority: -50,
              createdAt: '2026-11-10T12:00:00.000Z',
            },
          },
          { status: 202 },
        );
      }
      return Response.json(fixtureGuestDetail);
    });
    vi.stubGlobal('fetch', fetchFn);
    const user = userEvent.setup();
    renderDetail();

    await screen.findByRole('heading', { name: 'Example LXC' });
    await user.click(screen.getByRole('button', { name: 'Check storage' }));
    expect(
      await screen.findByText(/Storage check queued as job job-storage/),
    ).toBeVisible();
    const request = fetchFn.mock.calls.at(-1)?.[0] as Request;
    expect(request.method).toBe('POST');
    expect(new URL(request.url).pathname).toBe(
      '/api/hosts/fixture-host/guests/112/storage/check',
    );
  });

  it('shows an orphan warning and missing live metrics without rendering YAML', async () => {
    installDetailApi(orphanDetail);
    renderDetail('/resources/fixture-host/212?type=not-a-type');

    expect(await screen.findByText('Unmanaged guest (orphan)')).toBeVisible();
    expect(screen.getAllByText('Not reported').length).toBeGreaterThan(0);
    expect(screen.getAllByText('No YAML')).toHaveLength(10);
    expect(screen.getByText('No raw configuration returned.')).toBeVisible();
    expect(screen.getByText('qm config')).toBeVisible();
    expect(screen.queryByTestId('yaml-code-viewer')).toBeNull();
  });

  it('imports an orphan to YAML and refreshes when the job completes', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    FakeEventSource.instances.length = 0;
    const api = installOrphanApi();
    const user = userEvent.setup();
    renderDetail('/resources/fixture-host/212?type=vm');

    await screen.findByText('Unmanaged guest (orphan)');
    await user.click(screen.getByRole('button', { name: 'Import to YAML' }));
    expect(
      await screen.findByText(/Import queued as job job-import/),
    ).toBeVisible();
    expect(FakeEventSource.instances).toHaveLength(1);

    const before = api.detailCalls();
    act(() => FakeEventSource.instances[0]!.emit('job', { status: 'running' }));
    expect(api.detailCalls()).toBe(before);

    act(() =>
      FakeEventSource.instances[0]!.emit('job', { status: 'completed' }),
    );
    expect(await screen.findByText(/Queued job finished/)).toBeVisible();
    await waitFor(() => expect(api.detailCalls()).toBeGreaterThan(before));
  });

  it.each([
    ['plan-fail', 'Unable to create the import plan.'],
    ['apply-fail', 'Unable to queue the import job.'],
    ['network', 'Unable to import this guest.'],
  ] as const)('reports %s orphan import failures', async (mode, message) => {
    installOrphanApi(mode);
    const user = userEvent.setup();
    renderDetail('/resources/fixture-host/212?type=vm');
    await screen.findByText('Unmanaged guest (orphan)');
    await user.click(screen.getByRole('button', { name: 'Import to YAML' }));
    expect(await screen.findByText(message)).toBeVisible();
  });

  it('keeps orphan import read-only for viewers', async () => {
    installOrphanApi();
    renderDetail('/resources/fixture-host/212?type=vm', 'viewer');
    await screen.findByText('Unmanaged guest (orphan)');
    expect(
      screen.getByRole('button', { name: 'Import to YAML' }),
    ).toBeDisabled();
  });

  it('ignores an orphan, records it in host.yaml and refreshes the detail', async () => {
    installIgnoreApi();
    const user = userEvent.setup();
    renderDetail('/resources/fixture-host/212?type=vm');

    await screen.findByText('Unmanaged guest (orphan)');
    await user.click(screen.getByRole('button', { name: 'Ignore guest' }));
    expect(
      await screen.findByText(
        /Ignored Unmanaged VM\. The identity is recorded/,
      ),
    ).toBeVisible();
    expect(await screen.findByText('Ignored guest')).toBeVisible();
    expect(screen.queryByText('Unmanaged guest (orphan)')).toBeNull();
    expect(screen.getAllByText('Ignored')).toHaveLength(10);
  });

  it.each([
    ['http', 'Unable to ignore this guest.'],
    ['network', 'Unable to ignore this guest.'],
    ['non-error', 'Unable to ignore this guest.'],
  ] as const)('reports %s ignore failures', async (mode, message) => {
    installIgnoreApi(mode);
    const user = userEvent.setup();
    renderDetail('/resources/fixture-host/212?type=vm');
    await screen.findByText('Unmanaged guest (orphan)');
    await user.click(screen.getByRole('button', { name: 'Ignore guest' }));
    expect(await screen.findByText(message)).toBeVisible();
  });

  it('keeps the ignore action read-only for viewers', async () => {
    installIgnoreApi();
    renderDetail('/resources/fixture-host/212?type=vm', 'viewer');
    await screen.findByText('Unmanaged guest (orphan)');
    expect(screen.getByRole('button', { name: 'Ignore guest' })).toBeDisabled();
  });

  it('explains an already ignored guest and still allows importing it', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    FakeEventSource.instances.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const request = input as Request;
        const path = new URL(request.url).pathname;
        if (request.method === 'POST' && path === '/api/plans/guest-import') {
          return Response.json({ id: 'plan-import' }, { status: 201 });
        }
        if (request.method === 'POST' && path.endsWith('/apply')) {
          return Response.json(
            {
              plan: { id: 'plan-import', status: 'applying' },
              job: { id: 'job-import' },
            },
            { status: 202 },
          );
        }
        return Response.json(ignoredDetail);
      }),
    );
    const user = userEvent.setup();
    renderDetail('/resources/fixture-host/212?type=vm');

    expect(await screen.findByText('Ignored guest')).toBeVisible();
    expect(screen.getByText(/not reported as an orphan/)).toBeVisible();
    const importButton = screen.getByRole('button', {
      name: 'Import to YAML instead',
    });
    expect(importButton).toBeEnabled();
    await user.click(importButton);
    expect(
      await screen.findByText(/Import queued as job job-import/),
    ).toBeVisible();
  });

  it('opens the YAML editor, applies saved content, and keeps viewers read-only', async () => {
    installDetailApi();
    const user = userEvent.setup();
    const adminView = renderDetail();
    await screen.findByRole('heading', { name: 'Example LXC' });
    await user.click(screen.getByRole('button', { name: 'Edit YAML' }));
    expect(screen.getByText('Mock YAML editor')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Mock save' }));
    await user.click(screen.getByRole('button', { name: 'Mock cancel' }));
    expect(
      await screen.findByLabelText('Example LXC deployment YAML'),
    ).toHaveTextContent('ram: 2048');
    adminView.unmount();

    installDetailApi();
    renderDetail('/resources/fixture-host/112?type=lxc', 'viewer');
    await screen.findByRole('heading', { name: 'Example LXC' });
    expect(screen.getByRole('button', { name: 'Edit YAML' })).toBeDisabled();
  });

  it('falls back to viewer power controls without an authenticated role', async () => {
    installDetailApi();
    render(
      <MemoryRouter initialEntries={['/resources/fixture-host/112?type=lxc']}>
        <AuthProvider initialUser={null}>
          <Routes>
            <Route
              path="/resources/:hostId/:vmid"
              element={<GuestDetailPage />}
            />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { name: 'Example LXC' });
    expect(screen.getByText(/Viewers can inspect/)).toBeVisible();
  });

  it('rejects an invalid route without making an API call', async () => {
    const fetchFn = installDetailApi();
    renderDetail('/resources/fixture-host/not-a-number');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Invalid guest route.',
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    ['http', 'Guest not found or access denied.'],
    ['network', 'fixture offline'],
    ['non-error', 'fixture offline'],
  ] as const)('reports %s guest detail failures', async (failure, message) => {
    installDetailApi(undefined, failure);
    renderDetail();
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
  });
});

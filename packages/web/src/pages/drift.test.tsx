import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../auth/auth-context';
import { DriftPage } from './drift';

type Role = 'admin' | 'operator' | 'viewer';

interface TestChange {
  readonly path: string;
  readonly category:
    | 'config'
    | 'network'
    | 'disk'
    | 'mount'
    | 'feature'
    | 'tags'
    | 'protection'
    | 'cloud_init'
    | 'identity';
  readonly kind: 'changed' | 'missing_in_live' | 'missing_in_yaml';
  readonly desired: unknown;
  readonly actual: unknown;
  readonly pullable: boolean;
  readonly computed: boolean;
  readonly secret: boolean;
  readonly tag?: 'env' | 'secret' | 'expr' | 'cmd' | 'include';
  readonly warnings?: readonly string[];
}

interface TestSnapshot {
  readonly id: string;
  readonly hostId: string;
  readonly vmid: number;
  readonly type: 'lxc' | 'vm';
  readonly status: 'in_sync' | 'drifted';
  readonly changes: readonly TestChange[];
  readonly computedFields: readonly string[];
  readonly ignoredPaths: readonly string[];
  readonly checkedAt: string;
}

const fixtureHost = {
  id: 'fixture-host',
  name: 'Fixture Host',
  type: 'proxmox' as const,
  index: 1,
  status: 'healthy' as const,
  runtime: {
    overall: 'healthy',
    ssh: { status: 'connected' },
    api: { configured: true, status: 'connected' },
    vault: { status: 'unlocked' },
    queue: { status: 'idle' },
    issues: [],
  },
  updatedAt: '2026-01-01T00:00:00Z',
};

const fixtureGuests = [
  {
    hostId: 'fixture-host',
    vmid: 112,
    name: 'Example LXC',
    type: 'lxc' as const,
    status: 'running',
    node: 'fixture-node',
    configuration: {
      status: 'configured' as const,
      relativePath: 'hosts/fixture-host/112-example-lxc/deployment.yaml',
    },
  },
  {
    hostId: 'fixture-host',
    vmid: 212,
    name: 'Unmanaged VM',
    type: 'vm' as const,
    status: 'stopped',
    node: 'fixture-node',
    configuration: { status: 'orphan' as const },
  },
];

const driftChanges: readonly TestChange[] = [
  {
    path: 'ram',
    category: 'config',
    kind: 'changed',
    desired: 1024,
    actual: 2048,
    pullable: true,
    computed: false,
    secret: false,
    warnings: ['memory differs'],
  },
  {
    path: 'cpu',
    category: 'config',
    kind: 'changed',
    desired: 'host.index + 1',
    actual: 4,
    pullable: false,
    computed: true,
    secret: false,
    tag: 'expr',
  },
  {
    path: 'root_password',
    category: 'config',
    kind: 'changed',
    desired: '***',
    actual: '***',
    pullable: false,
    computed: false,
    secret: true,
  },
  {
    path: 'tags',
    category: 'tags',
    kind: 'missing_in_live',
    desired: ['app'],
    actual: null,
    pullable: false,
    computed: false,
    secret: false,
  },
  {
    path: 'swap',
    category: 'config',
    kind: 'missing_in_yaml',
    desired: null,
    actual: 512,
    pullable: true,
    computed: false,
    secret: false,
  },
  {
    path: 'nic0',
    category: 'network',
    kind: 'changed',
    desired: { bridge: 'vmbr0' },
    actual: { bridge: 'vmbr1' },
    pullable: false,
    computed: false,
    secret: false,
  },
  {
    path: 'protection',
    category: 'protection',
    kind: 'changed',
    desired: true,
    actual: false,
    pullable: true,
    computed: false,
    secret: false,
  },
];

const driftedSnapshot: TestSnapshot = {
  id: 'snapshot-112',
  hostId: 'fixture-host',
  vmid: 112,
  type: 'lxc',
  status: 'drifted',
  changes: driftChanges,
  computedFields: ['cpu'],
  ignoredPaths: [],
  checkedAt: '2026-11-09T10:00:00.000Z',
};

const inSyncSnapshot: TestSnapshot = {
  id: 'snapshot-212',
  hostId: 'fixture-host',
  vmid: 212,
  type: 'vm',
  status: 'in_sync',
  changes: [],
  computedFields: [],
  ignoredPaths: [],
  checkedAt: '2026-11-09T11:00:00.000Z',
};

const unknownHostSnapshot: TestSnapshot = {
  id: 'snapshot-999',
  hostId: 'unknown-host',
  vmid: 999,
  type: 'lxc',
  status: 'in_sync',
  changes: [],
  computedFields: [],
  ignoredPaths: [],
  checkedAt: '2026-11-09T12:00:00.000Z',
};

interface CapturedRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

interface MockOptions {
  readonly snapshots?: readonly TestSnapshot[];
  readonly hosts?: readonly (typeof fixtureHost)[];
  readonly guests?: readonly (typeof fixtureGuests)[number][];
  readonly drift?: () => Response | Promise<Response>;
  readonly checkGuest?: (
    request: Request,
    body: unknown,
  ) => Response | Promise<Response>;
  readonly checkHost?: (
    request: Request,
    body: unknown,
  ) => Response | Promise<Response>;
  readonly pull?: (
    request: Request,
    body: unknown,
  ) => Response | Promise<Response>;
  readonly enforce?: (
    request: Request,
    body: unknown,
  ) => Response | Promise<Response>;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installApi(options: MockOptions = {}) {
  const requests: CapturedRequest[] = [];
  const fetchFn = vi.fn(async (input: Request) => {
    const request = input;
    const url = new URL(request.url);
    let body: unknown;
    if (request.method !== 'GET') {
      body = await request
        .clone()
        .json()
        .catch(() => undefined);
    }
    requests.push({ method: request.method, path: url.pathname, body });

    if (request.method === 'GET' && url.pathname === '/api/drift') {
      if (options.drift) return options.drift();
      return json({
        snapshots: options.snapshots ?? [driftedSnapshot, inSyncSnapshot],
      });
    }
    if (request.method === 'GET' && url.pathname === '/api/hosts') {
      return json({ hosts: options.hosts ?? [fixtureHost] });
    }
    if (request.method === 'GET' && url.pathname === '/api/inventory/guests') {
      return json({ guests: options.guests ?? fixtureGuests });
    }
    if (
      request.method === 'POST' &&
      /^\/api\/drift\/hosts\/[^/]+\/check$/.test(url.pathname)
    ) {
      if (options.checkHost) return options.checkHost(request, body);
      return json({
        hostId: 'fixture-host',
        checked: 0,
        snapshots: [],
        failures: [],
      });
    }
    if (
      request.method === 'POST' &&
      /^\/api\/drift\/[^/]+\/[^/]+\/check$/.test(url.pathname)
    ) {
      if (options.checkGuest) return options.checkGuest(request, body);
      return json(driftedSnapshot);
    }
    if (
      request.method === 'POST' &&
      /^\/api\/drift\/[^/]+\/[^/]+\/pull$/.test(url.pathname)
    ) {
      if (options.pull) return options.pull(request, body);
      return json({
        hostId: 'fixture-host',
        vmid: 112,
        dryRun: false,
        applied: [
          {
            path: 'ram',
            targetFile: 'hosts/fixture-host/112-example-lxc/deployment.yaml',
            layer: 'override',
            previousValue: 1024,
            newValue: 2048,
          },
        ],
        failures: [],
        snapshot: driftedSnapshot,
      });
    }
    if (
      request.method === 'POST' &&
      /^\/api\/drift\/[^/]+\/[^/]+\/enforce$/.test(url.pathname)
    ) {
      if (options.enforce) return options.enforce(request, body);
      return json(
        {
          plan: { id: 'plan-1', operation: 'guest.update' },
          job: { id: 'job-1', status: 'queued' },
        },
        202,
      );
    }
    return json({}, 404);
  });
  vi.stubGlobal('fetch', fetchFn);
  return { fetchFn, requests };
}

function renderDrift(role: Role = 'admin') {
  return render(
    <AuthProvider initialUser={{ id: 'user-1', username: role, role }}>
      <DriftPage />
    </AuthProvider>,
  );
}

function article(name: string): HTMLElement {
  return screen.getByRole('article', { name });
}

async function expand(name: string) {
  const user = userEvent.setup();
  await user.click(
    within(article(name)).getByRole('button', { name: 'Show diff' }),
  );
  return user;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DriftPage', () => {
  it('renders the grouped snapshot list, summary counts and filters', async () => {
    const { fetchFn } = installApi({
      snapshots: [driftedSnapshot, inSyncSnapshot, unknownHostSnapshot],
    });
    const view = renderDrift();

    expect(view.container.querySelectorAll('.animate-pulse')).toHaveLength(3);

    expect(
      await screen.findByRole('heading', { name: 'Fixture Host' }),
    ).toBeVisible();
    expect(screen.getByRole('heading', { name: 'unknown-host' })).toBeVisible();
    expect(screen.getByText('Example LXC')).toBeVisible();
    expect(screen.getByText('Unmanaged VM')).toBeVisible();
    expect(screen.getByText('Guest 999')).toBeVisible();
    expect(screen.getAllByText('LXC').length).toBeGreaterThan(0);
    expect(screen.getByText('VM')).toBeVisible();

    const driftedCard = screen.getByText('Drifted guests').parentElement!;
    expect(within(driftedCard).getByText('1')).toBeVisible();
    const pullableCard = screen.getByText('Pullable fields').parentElement!;
    expect(within(pullableCard).getByText('3')).toBeVisible();
    const protectedCard = screen.getByText('Protected fields').parentElement!;
    expect(within(protectedCard).getByText('4')).toBeVisible();

    const user = userEvent.setup();
    await user.selectOptions(
      screen.getByLabelText('Filter drift by host'),
      'fixture-host',
    );
    expect(screen.queryByText('Guest 999')).toBeNull();
    expect(screen.getByText('Example LXC')).toBeVisible();

    await user.selectOptions(
      screen.getByLabelText('Filter drift by status'),
      'in_sync',
    );
    expect(screen.queryByText('Example LXC')).toBeNull();
    expect(screen.getByText('Unmanaged VM')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Reset filters' }));
    expect(screen.getByLabelText('Filter drift by host')).toHaveValue('');
    expect(screen.getByLabelText('Filter drift by status')).toHaveValue('');
    expect(screen.getByText('Example LXC')).toBeVisible();

    const search = screen.getByLabelText('Search drift');
    await user.type(search, '999');
    expect(screen.getByText('Guest 999')).toBeVisible();
    expect(screen.queryByText('Example LXC')).toBeNull();

    await user.clear(search);
    await user.type(search, 'example');
    expect(screen.getByText('Example LXC')).toBeVisible();
    expect(screen.queryByText('Guest 999')).toBeNull();

    await user.clear(search);
    await user.type(search, 'zzz');
    expect(screen.getByText('No drift snapshots match')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Reset filters' }));
    expect(screen.getByText('Guest 999')).toBeVisible();

    const callsBeforeRefresh = fetchFn.mock.calls.length;
    await user.click(screen.getByRole('button', { name: 'Refresh snapshots' }));
    await waitFor(() => {
      expect(fetchFn.mock.calls.length).toBeGreaterThan(callsBeforeRefresh);
    });
  });

  it('renders the diff with value formats, badges and responsive columns', async () => {
    installApi();
    const view = renderDrift();
    await screen.findByText('Example LXC');

    const user = await expand('Example LXC');
    expect(
      within(article('Example LXC')).getByRole('button', { name: 'Hide diff' }),
    ).toBeVisible();

    const ram = screen.getByTestId('drift-change-ram');
    expect(within(ram).getByText('1024')).toBeVisible();
    expect(within(ram).getByText('2048')).toBeVisible();
    expect(within(ram).getByText('memory differs')).toBeVisible();

    const cpu = screen.getByTestId('drift-change-cpu');
    expect(within(cpu).getByText('!expr')).toBeVisible();
    expect(within(cpu).getByText('Computed — not pullable')).toBeVisible();

    expect(
      within(screen.getByTestId('drift-change-root_password')).getByText(
        'Secret — not pullable',
      ),
    ).toBeVisible();
    expect(
      within(screen.getByTestId('drift-change-tags')).getByText(
        'Missing in live — cannot pull',
      ),
    ).toBeVisible();
    expect(
      within(screen.getByTestId('drift-change-nic0')).getByText('Not pullable'),
    ).toBeVisible();

    expect(
      within(screen.getByTestId('drift-change-nic0')).getByText(/vmbr0/),
    ).toBeVisible();
    expect(screen.getByTestId('drift-change-protection').textContent).toContain(
      'true',
    );
    expect(screen.getByTestId('drift-change-swap').textContent).toContain('—');
    expect(
      within(screen.getByTestId('drift-change-swap')).getByText(
        'The live guest has a value that is absent from YAML.',
      ),
    ).toBeVisible();
    expect(
      within(screen.getByTestId('drift-change-tags')).getByText(
        'The YAML field has no live counterpart.',
      ),
    ).toBeVisible();

    const grid = view.container.querySelector('.md\\:grid-cols-2');
    expect(grid).not.toBeNull();
    expect(grid!.className).toContain('grid-cols-1');

    await user.click(
      within(article('Example LXC')).getByRole('button', { name: 'Hide diff' }),
    );
    expect(screen.queryByTestId('drift-change-ram')).toBeNull();

    await expand('Unmanaged VM');
    expect(
      within(article('Unmanaged VM')).getByText('YAML and live state match.'),
    ).toBeVisible();
  });

  it('pulls selected fields, all fields and single fields', async () => {
    const { requests } = installApi();
    renderDrift();
    await screen.findByText('Example LXC');
    const user = await expand('Example LXC');

    await user.click(screen.getByLabelText('Select field ram'));
    await user.click(screen.getByRole('button', { name: 'Pull selected (1)' }));
    await waitFor(() => {
      expect(
        screen.getByText('Pulled 1 field into YAML for Example LXC.'),
      ).toBeVisible();
    });
    expect(
      requests.filter((request) => request.path.endsWith('/pull')).at(-1)?.body,
    ).toEqual({ paths: ['ram'] });

    await user.click(
      screen.getByLabelText('Select all pullable fields for Example LXC'),
    );
    await user.click(screen.getByRole('button', { name: 'Pull selected (3)' }));
    await waitFor(() => {
      expect(
        requests.filter((request) => request.path.endsWith('/pull')).at(-1)
          ?.body,
      ).toEqual({ paths: ['ram', 'swap', 'protection'] });
    });

    await user.click(
      screen.getByLabelText('Select all pullable fields for Example LXC'),
    );
    await user.click(
      screen.getByLabelText('Select all pullable fields for Example LXC'),
    );
    await user.click(screen.getByRole('button', { name: 'Pull all' }));
    await waitFor(() => {
      expect(
        requests.filter((request) => request.path.endsWith('/pull')).at(-1)
          ?.body,
      ).toEqual({});
    });

    const swap = screen.getByTestId('drift-change-swap');
    await user.click(within(swap).getByRole('button', { name: 'Pull field' }));
    await waitFor(() => {
      expect(
        requests.filter((request) => request.path.endsWith('/pull')).at(-1)
          ?.body,
      ).toEqual({ paths: ['swap'] });
    });
  });

  it('reports pull failures and pull errors', async () => {
    let call = 0;
    installApi({
      pull: () => {
        call += 1;
        if (call === 1) {
          return json({
            hostId: 'fixture-host',
            vmid: 112,
            dryRun: false,
            applied: [
              {
                path: 'ram',
                targetFile: 'deployment.yaml',
                layer: 'override',
                previousValue: 1024,
                newValue: 2048,
              },
            ],
            failures: [
              { path: 'tags', reason: 'not_pullable', message: 'nope' },
              { path: 'cpu', reason: 'not_pullable', message: 'nope' },
            ],
            snapshot: driftedSnapshot,
          });
        }
        if (call === 2) {
          return json({
            hostId: 'fixture-host',
            vmid: 112,
            dryRun: false,
            applied: [],
            failures: [
              { path: 'tags', reason: 'not_pullable', message: 'nope' },
            ],
            snapshot: driftedSnapshot,
          });
        }
        return json(
          {
            statusCode: 409,
            error: 'Conflict',
            message: 'Write conflict detected',
          },
          409,
        );
      },
    });
    renderDrift();
    await screen.findByText('Example LXC');
    const user = await expand('Example LXC');

    await user.click(screen.getByRole('button', { name: 'Pull all' }));
    expect(
      await screen.findByText(
        'Pulled 1 field into YAML for Example LXC; 2 fields could not be pulled.',
      ),
    ).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Pull all' }));
    expect(
      await screen.findByText(
        'Pulled 0 fields into YAML for Example LXC; 1 field could not be pulled.',
      ),
    ).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Pull all' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Write conflict detected',
    );
  });

  it('checks a guest and a host, merging returned snapshots', async () => {
    const checkedSnapshot: TestSnapshot = {
      ...inSyncSnapshot,
      id: 'snapshot-112',
      vmid: 112,
      type: 'lxc',
    };
    const newSnapshot: TestSnapshot = {
      ...inSyncSnapshot,
      id: 'snapshot-113',
      vmid: 113,
    };
    installApi({
      checkGuest: () => json(checkedSnapshot),
      checkHost: () =>
        json({
          hostId: 'fixture-host',
          checked: 2,
          snapshots: [{ ...inSyncSnapshot, vmid: 212 }, newSnapshot],
          failures: [{ hostId: 'fixture-host', vmid: 500, message: 'boom' }],
        }),
    });
    renderDrift();
    await screen.findByText('Example LXC');

    const user = userEvent.setup();
    await user.click(
      within(article('Example LXC')).getByRole('button', { name: 'Check' }),
    );
    expect(await screen.findByText('Checked Example LXC.')).toBeVisible();
    expect(within(article('Example LXC')).getByText('In sync')).toBeVisible();
    expect(
      within(article('Example LXC')).queryByRole('button', { name: 'Enforce' }),
    ).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Check host' }));
    expect(
      await screen.findByText('Checked 2 guests on Fixture Host; 1 failed.'),
    ).toBeVisible();
    expect(screen.getByText('Guest 113')).toBeVisible();
  });

  it('requires typed confirmation before enforcing a destructive plan', async () => {
    const { requests } = installApi({
      enforce: (_request, body) => {
        const confirmation = (body as { confirmation?: string } | undefined)
          ?.confirmation;
        if (!confirmation) {
          return json(
            {
              statusCode: 400,
              error: 'Bad Request',
              message: 'Typed confirmation required',
              confirmationText: 'UPDATE fixture-host/112',
            },
            400,
          );
        }
        return json(
          {
            plan: { id: 'plan-1', operation: 'guest.update' },
            job: { id: 'job-1', status: 'queued' },
          },
          202,
        );
      },
    });
    renderDrift();
    await screen.findByText('Example LXC');
    const user = userEvent.setup();

    await user.click(
      within(article('Example LXC')).getByRole('button', { name: 'Enforce' }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Confirm enforce for Example LXC',
    });
    expect(dialog).toHaveTextContent('UPDATE fixture-host/112');
    const confirm = within(dialog).getByRole('button', {
      name: 'Confirm enforce',
    });
    expect(confirm).toBeDisabled();

    const input = within(dialog).getByLabelText('Confirmation text');
    await user.type(input, 'wrong');
    expect(confirm).toBeDisabled();
    await user.clear(input);
    await user.type(input, 'UPDATE fixture-host/112');
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    expect(
      await screen.findByText(
        'Queued plan plan-1 in job job-1 for Example LXC.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('dialog')).toBeNull();

    const enforceRequests = requests.filter((request) =>
      request.path.endsWith('/enforce'),
    );
    expect(enforceRequests[0]!.body).toEqual({});
    expect(enforceRequests[1]!.body).toEqual({
      confirmation: 'UPDATE fixture-host/112',
    });

    await user.click(
      within(article('Example LXC')).getByRole('button', { name: 'Enforce' }),
    );
    const secondDialog = await screen.findByRole('dialog');
    await user.click(
      within(secondDialog).getByRole('button', { name: 'Cancel' }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('reports enforce, check and load failures', async () => {
    let enforceCall = 0;
    installApi({
      enforce: () => {
        enforceCall += 1;
        if (enforceCall === 1) {
          return json(
            {
              statusCode: 500,
              error: 'Server Error',
              message: 'enforce failed',
            },
            500,
          );
        }
        return json({ statusCode: 409, error: 'Conflict' }, 409);
      },
    });
    renderDrift();
    await screen.findByText('Example LXC');
    const user = userEvent.setup();

    await user.click(
      within(article('Example LXC')).getByRole('button', { name: 'Enforce' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'enforce failed',
    );

    await user.click(
      within(article('Example LXC')).getByRole('button', { name: 'Enforce' }),
    );
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Conflict');
    });
  });

  it('reports check failures and non-error throwables', async () => {
    let checkCall = 0;
    installApi({
      checkHost: async () => {
        checkCall += 1;
        if (checkCall === 1) throw new Error('host offline');
        throw 'device unavailable';
      },
    });
    renderDrift();
    await screen.findByText('Example LXC');

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Check host' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('host offline');

    installApi({
      checkGuest: () => json({ statusCode: 400, error: 'Bad Request' }, 400),
    });
    await user.click(
      within(article('Example LXC')).getByRole('button', { name: 'Check' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Bad Request');
  });

  it('renders an error state when snapshots cannot be loaded', async () => {
    installApi({
      drift: () => json({ statusCode: 500, error: 'Server Error' }, 500),
    });
    renderDrift();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to load drift snapshots.',
    );
    expect(screen.getByText('No drift snapshots match')).toBeVisible();
  });

  it('surfaces network and string load failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('network down')),
    );
    const first = renderDrift();
    expect(await screen.findByRole('alert')).toHaveTextContent('network down');
    first.unmount();

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue('network off'));
    renderDrift();
    expect(await screen.findByRole('alert')).toHaveTextContent('network off');
  });

  it('disables resolution actions for viewers', async () => {
    installApi();
    renderDrift('viewer');
    await screen.findByText('Example LXC');
    const user = await expand('Example LXC');

    expect(
      within(article('Example LXC')).getByRole('button', { name: 'Enforce' }),
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Pull all' })).toBeDisabled();
    expect(
      screen.getByLabelText('Select all pullable fields for Example LXC'),
    ).toBeDisabled();
    expect(screen.getByLabelText('Select field ram')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Check host' })).toBeDisabled();
    expect(
      within(article('Example LXC')).getByRole('button', { name: 'Check' }),
    ).toBeEnabled();

    await user.click(screen.getByLabelText('Select field ram'));
    expect(screen.getByLabelText('Select field ram')).not.toBeChecked();
  });
});

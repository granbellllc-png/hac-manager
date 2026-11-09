import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, type AuthUser } from '../auth/auth-context';
import { JobsPage, jobsPageInternals } from './jobs';

class MockEventSource {
  public static readonly CONNECTING = 0;
  public static readonly OPEN = 1;
  public static readonly CLOSED = 2;
  public static instances: MockEventSource[] = [];
  public readonly listeners = new Map<string, Set<(event: Event) => void>>();
  public readyState = MockEventSource.CONNECTING;

  public constructor(public readonly url: string) {
    MockEventSource.instances.push(this);
  }

  public addEventListener(type: string, listener: (event: Event) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  public close() {
    this.readyState = MockEventSource.CLOSED;
  }

  public emit(type: string, value?: unknown) {
    if (type === 'open') this.readyState = MockEventSource.OPEN;
    const event =
      value === undefined
        ? new Event(type)
        : new MessageEvent(type, { data: JSON.stringify(value) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const baseJobs = [
  {
    id: 'job-1',
    hostId: 'pve-01',
    vmid: 112,
    lane: 'guest',
    type: 'plan.apply',
    status: 'queued',
    priority: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'job-2',
    hostId: 'pve-02',
    lane: 'host',
    type: 'probe',
    status: 'completed',
    priority: 0,
    createdAt: '2025-12-31T00:00:00.000Z',
    finishedAt: '2025-12-31T00:01:00.000Z',
  },
] as const;

function installApi(options?: {
  readonly jobs?: readonly Record<string, unknown>[];
  readonly prompt?: Record<string, unknown> | null;
  readonly failJobs?: boolean;
  readonly failDetail?: boolean;
  readonly failPrompts?: boolean;
  readonly failCancel?: boolean;
  readonly failResolution?: boolean;
  readonly pagedLogs?: boolean;
}) {
  let prompt = options?.prompt ?? null;
  const requests: Request[] = [];
  const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const request = input as Request;
    requests.push(request.clone());
    const url = new URL(request.url);
    if (url.pathname === '/api/jobs' && request.method === 'GET') {
      if (options?.failJobs) return Response.json({}, { status: 500 });
      return Response.json({ jobs: options?.jobs ?? baseJobs });
    }
    if (url.pathname === '/api/prompts' && request.method === 'GET') {
      if (options?.failPrompts) return Response.json({}, { status: 500 });
      return Response.json({ prompts: prompt ? [prompt] : [] });
    }
    if (url.pathname === '/api/jobs/job-1' && request.method === 'GET') {
      if (options?.failDetail) return Response.json({}, { status: 500 });
      return Response.json({
        job: baseJobs[0],
        steps: [
          {
            jobId: 'job-1',
            stepIndex: 0,
            name: 'apply change',
            status: 'running',
            rollbackHint: 'Inspect the target.',
          },
        ],
        prompts: prompt ? [prompt] : [],
      });
    }
    if (url.pathname === '/api/jobs/job-2' && request.method === 'GET') {
      return Response.json({ job: baseJobs[1], steps: [], prompts: [] });
    }
    if (url.pathname.endsWith('/logs') && request.method === 'GET') {
      const after = Number(url.searchParams.get('after') ?? 0);
      if (options?.pagedLogs && after === 0) {
        return Response.json({
          logs: Array.from({ length: 2_000 }, (_, index) => ({
            jobId: 'job-1',
            seq: index + 1,
            ts: '2026-01-01T00:00:00.000Z',
            stream: 'stdout',
            text: `paged ${index + 1}`,
          })),
          nextCursor: 2_000,
        });
      }
      return Response.json({
        logs: url.pathname.includes('job-1')
          ? [
              {
                jobId: 'job-1',
                seq: 1,
                ts: '2026-01-01T00:00:00.000Z',
                stream: 'system',
                text: 'Job queued',
              },
            ]
          : [],
        nextCursor: 1,
      });
    }
    if (
      url.pathname === '/api/jobs/job-1/cancel' &&
      request.method === 'POST'
    ) {
      if (options?.failCancel) return Response.json({}, { status: 409 });
      return Response.json({ job: { ...baseJobs[0], status: 'cancelled' } });
    }
    if (url.pathname.includes('/api/prompts/') && request.method === 'POST') {
      if (options?.failResolution) return Response.json({}, { status: 400 });
      const resolved = prompt;
      prompt = null;
      return Response.json({ ...resolved, status: 'resolved' });
    }
    return Response.json({});
  });
  vi.stubGlobal('fetch', fetchFn);
  return { fetchFn, requests };
}

function renderJobs(user?: AuthUser) {
  return render(
    <AuthProvider
      initialUser={
        user ?? { id: 'operator-1', username: 'operator', role: 'operator' }
      }
      initialSetupNeeded={false}
    >
      <JobsPage />
    </AuthProvider>,
  );
}

beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal('EventSource', MockEventSource);
});

describe('JobsPage', () => {
  it('classifies statuses, validates events, formats time, and merges logs', () => {
    expect(jobsPageInternals.isJobSummary(null)).toBe(false);
    expect(jobsPageInternals.isJobSummary({ id: 'missing-fields' })).toBe(
      false,
    );
    expect(jobsPageInternals.isJobSummary(baseJobs[0])).toBe(true);
    for (const status of [
      'completed',
      'failed',
      'interrupted',
      'cancelled',
      'waiting_input',
      'running',
    ] as const) {
      expect(jobsPageInternals.statusClass(status)).toBeTruthy();
    }
    expect(jobsPageInternals.formatTime(undefined)).toBe('—');
    expect(jobsPageInternals.formatTime('2026-01-01T00:00:00.000Z')).not.toBe(
      '—',
    );
    expect(jobsPageInternals.errorMessage(null, 'fallback')).toBe('fallback');
    expect(
      jobsPageInternals.errorMessage({ message: 'specific' }, 'fallback'),
    ).toBe('specific');
    expect(
      jobsPageInternals.mergeLogLines(
        [
          {
            jobId: 'job',
            seq: 2,
            ts: '',
            stream: 'stdout',
            text: 'old',
          },
        ],
        [
          {
            jobId: 'job',
            seq: 1,
            ts: '',
            stream: 'system',
            text: 'first',
          },
          {
            jobId: 'job',
            seq: 2,
            ts: '',
            stream: 'stdout',
            text: 'new',
          },
        ],
      ),
    ).toEqual([
      expect.objectContaining({ seq: 1 }),
      expect.objectContaining({ seq: 2, text: 'new' }),
    ]);
  });

  it('shows queues, details, live updates, filters, and cancellation', async () => {
    const { requests } = installApi();
    const user = userEvent.setup();
    renderJobs();

    expect(
      await screen.findByRole('heading', { name: 'Jobs & Queue' }),
    ).toBeVisible();
    expect(await screen.findByText('apply change')).toBeVisible();
    expect(screen.getByText('Job queued')).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Filter queue for pve-01' }),
    ).toHaveTextContent('1 active');
    expect(MockEventSource.instances.map((source) => source.url)).toEqual(
      expect.arrayContaining(['/api/events', '/api/jobs/job-1/events']),
    );

    const globalSource = MockEventSource.instances.find(
      (source) => source.url === '/api/events',
    )!;
    const jobSource = MockEventSource.instances.find((source) =>
      source.url.includes('/api/jobs/job-1/events'),
    )!;
    act(() => {
      globalSource.emit('open');
      globalSource.emit('job', { ...baseJobs[0], status: 'running' });
      globalSource.emit('job', {
        ...baseJobs[0],
        id: 'job-new',
        createdAt: '2026-01-02T00:00:00.000Z',
      });
      globalSource.emit('prompt', { id: 'global-prompt' });
      jobSource.emit('open');
      jobSource.emit('log', {
        jobId: 'job-1',
        seq: 2,
        ts: '2026-01-01T00:00:01.000Z',
        stream: 'stdout',
        text: 'Applying now',
      });
      jobSource.emit('prompt', { id: 'job-prompt' });
    });
    expect(screen.getByText('Applying now')).toBeVisible();
    expect(screen.getAllByText('running').length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    await user.selectOptions(screen.getByLabelText('Filter by host'), 'pve-01');
    await user.selectOptions(
      screen.getByLabelText('Filter by status'),
      'running',
    );
    await waitFor(() =>
      expect(
        requests.some((request) => request.url.includes('hostId=pve-01')),
      ).toBe(true),
    );
    await user.click(screen.getByRole('button', { name: 'Cancel job' }));
    expect((await screen.findAllByText('cancelled')).length).toBeGreaterThan(1);
    expect(
      requests.some(
        (request) =>
          new URL(request.url).pathname === '/api/jobs/job-1/cancel' &&
          request.method === 'POST',
      ),
    ).toBe(true);

    await user.click(
      screen.getByRole('button', { name: 'Filter queue for pve-02' }),
    );
    await user.click(screen.getByRole('button', { name: /probecompleted/ }));
    expect(await screen.findByRole('heading', { name: 'probe' })).toBeVisible();
  });

  it.each([
    {
      kind: 'choice',
      options: ['host', 'rootfs'],
      action: async (user: ReturnType<typeof userEvent.setup>) =>
        user.click(await screen.findByRole('button', { name: 'host' })),
    },
    {
      kind: 'confirm',
      options: [],
      action: async (user: ReturnType<typeof userEvent.setup>) =>
        user.click(await screen.findByRole('button', { name: 'Confirm' })),
    },
    {
      kind: 'confirm',
      options: [],
      action: async (user: ReturnType<typeof userEvent.setup>) =>
        user.click(await screen.findByRole('button', { name: 'Cancel' })),
    },
    {
      kind: 'typed_confirmation',
      options: [],
      action: async (user: ReturnType<typeof userEvent.setup>) => {
        await user.type(
          await screen.findByLabelText(
            'Type the requested confirmation exactly',
          ),
          'DELETE',
        );
        await user.click(
          screen.getByRole('button', { name: 'Submit confirmation' }),
        );
      },
    },
  ] as const)('resolves $kind prompts from the live modal', async (fixture) => {
    const prompt = {
      id: `prompt-${fixture.kind}`,
      jobId: 'job-1',
      hostId: 'pve-01',
      vmid: 112,
      kind: fixture.kind,
      status: 'pending',
      message: 'Choose safely',
      payload: {},
      options: fixture.options,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const { requests } = installApi({ prompt });
    const user = userEvent.setup();
    renderJobs();
    expect(await screen.findByRole('dialog')).toBeVisible();
    await fixture.action(user);
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    const resolution = requests.find(
      (request) =>
        new URL(request.url).pathname === `/api/prompts/${prompt.id}/resolve`,
    );
    expect(resolution).toBeDefined();
  });

  it('shows empty, viewer, and API failure states', async () => {
    installApi({ jobs: [] });
    const view = renderJobs({
      id: 'viewer-1',
      username: 'viewer',
      role: 'viewer',
    });
    expect(
      await screen.findByText('No jobs match these filters.'),
    ).toBeVisible();
    expect(
      screen.getByText('Select a job to inspect its progress.'),
    ).toBeVisible();
    view.unmount();

    installApi({ failJobs: true });
    renderJobs();
    expect(await screen.findByText('Could not load jobs.')).toBeVisible();
  });

  it('reports detail failures and ignores malformed live job events', async () => {
    installApi({ failDetail: true });
    renderJobs();
    expect(await screen.findByText('Could not load job.')).toBeVisible();
    const globalSource = MockEventSource.instances.find(
      (source) => source.url === '/api/events',
    )!;
    act(() => globalSource.emit('job', { unexpected: true }));
    expect(screen.getByText('Could not load job.')).toBeVisible();
  });

  it('paginates persisted logs before attaching the live stream', async () => {
    const { requests } = installApi({ pagedLogs: true });
    renderJobs();
    expect(await screen.findByText('2,000 lines')).toBeVisible();
    expect(requests.some((request) => request.url.includes('after=2000'))).toBe(
      true,
    );
  });

  it('surfaces cancellation and prompt-resolution failures', async () => {
    const prompt = {
      id: 'prompt-failure',
      jobId: 'job-1',
      hostId: 'pve-01',
      kind: 'confirm',
      status: 'pending',
      message: 'Continue?',
      payload: {},
      options: [],
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    installApi({ prompt, failCancel: true, failResolution: true });
    const user = userEvent.setup();
    renderJobs();
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(
      await within(screen.getByRole('dialog')).findByText(
        'Could not resolve prompt.',
      ),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Cancel job' }));
    expect(await screen.findByText('Could not cancel the job.')).toBeVisible();
  });

  it('reports prompt refresh failures from live events', async () => {
    const { requests } = installApi({ failPrompts: true });
    renderJobs();
    expect(
      await screen.findByText('Could not load pending prompts.'),
    ).toBeVisible();
    const source = MockEventSource.instances.find(
      (candidate) => candidate.url === '/api/events',
    )!;
    const before = requests.filter(
      (request) => new URL(request.url).pathname === '/api/prompts',
    ).length;
    act(() => source.emit('prompt', { id: 'new-prompt' }));
    await waitFor(() =>
      expect(
        requests.filter(
          (request) => new URL(request.url).pathname === '/api/prompts',
        ).length,
      ).toBeGreaterThan(before),
    );
  });
});

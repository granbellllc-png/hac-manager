import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CirclePause,
  CirclePlay,
  Clock3,
  RefreshCw,
  XCircle,
} from 'lucide-react';
import { apiClient } from '../api/client';
import { useAuth } from '../auth/auth-context';
import { VirtualLogViewer } from '../components/virtual-log-viewer';
import { Button } from '../components/ui/button';
import { useJobEvents, type JobLogEvent } from '../hooks/use-job-events';
import { useQueueEvents } from '../hooks/use-queue-events';
import { cn } from '../lib/utils';

type JobStatus =
  | 'queued'
  | 'running'
  | 'waiting_input'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

interface JobSummary {
  readonly id: string;
  readonly hostId: string;
  readonly vmid?: number | undefined;
  readonly lane: 'guest' | 'host';
  readonly type: string;
  readonly reason:
    | 'manual'
    | 'drift_push'
    | 'drift_pull'
    | 'schedule'
    | 'conflict_resolution'
    | 'orphan_action';
  readonly status: JobStatus;
  readonly priority: number;
  readonly triggeredBy?: string | undefined;
  readonly error?: string | undefined;
  readonly createdAt: string;
  readonly startedAt?: string | undefined;
  readonly finishedAt?: string | undefined;
}

interface JobStep {
  readonly jobId: string;
  readonly stepIndex: number;
  readonly name: string;
  readonly status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  readonly result?: unknown;
  readonly rollbackHint?: string | undefined;
}

interface JobPrompt {
  readonly id: string;
  readonly jobId: string;
  readonly hostId: string;
  readonly vmid?: number | undefined;
  readonly kind: 'choice' | 'confirm' | 'typed_confirmation';
  readonly status: 'pending' | 'resolved' | 'expired';
  readonly message: string;
  readonly payload: unknown;
  readonly options: readonly string[];
  readonly createdAt: string;
}

type PromptResolution =
  | { readonly kind: 'choice'; readonly choice: string }
  | { readonly kind: 'confirm'; readonly confirmed: boolean }
  | { readonly kind: 'typed_confirmation'; readonly text: string };

interface StorageSidePromptSummary {
  readonly exists: boolean;
  readonly fileCount: number;
  readonly bytes: number;
  readonly newestTimestamp?: string | undefined;
}

interface StoragePromptDetails {
  readonly status: string;
  readonly guestName: string;
  readonly guestPath: string;
  readonly hostPath: string;
  readonly mounted: boolean;
  readonly host: StorageSidePromptSummary;
  readonly rootfs: StorageSidePromptSummary;
  readonly staleDaemons: readonly {
    readonly name: string;
    readonly pid: number;
  }[];
  readonly recommendedResolution?: string | undefined;
}

interface VaultUnlockPromptDetails {
  readonly providerId: string;
  readonly providerName: string;
  readonly tokenLabel: string;
  readonly helpText: string;
}

const storageResolutionLabels: Readonly<Record<string, string>> = {
  'keep-host-data': 'Keep Host Data',
  'migrate-rootfs-to-host': 'Migrate Rootfs to Host',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseStorageSide(value: unknown): StorageSidePromptSummary | null {
  if (!isRecord(value)) return null;
  if (
    typeof value['exists'] !== 'boolean' ||
    typeof value['fileCount'] !== 'number' ||
    typeof value['bytes'] !== 'number'
  ) {
    return null;
  }
  return {
    exists: value['exists'],
    fileCount: value['fileCount'],
    bytes: value['bytes'],
    ...(typeof value['newestTimestamp'] === 'string'
      ? { newestTimestamp: value['newestTimestamp'] }
      : {}),
  };
}

function parseVaultUnlockPrompt(
  value: unknown,
): VaultUnlockPromptDetails | null {
  if (!isRecord(value) || value['type'] !== 'vault_unlock') return null;
  if (
    typeof value['providerId'] !== 'string' ||
    typeof value['providerName'] !== 'string' ||
    typeof value['tokenLabel'] !== 'string' ||
    typeof value['helpText'] !== 'string'
  ) {
    return null;
  }
  return {
    providerId: value['providerId'],
    providerName: value['providerName'],
    tokenLabel: value['tokenLabel'],
    helpText: value['helpText'],
  };
}

/** Parse the storage resolution payload without trusting the prompt JSON. */
function parseStoragePrompt(value: unknown): StoragePromptDetails | null {
  if (!isRecord(value)) return null;
  const host = parseStorageSide(value['host']);
  const rootfs = parseStorageSide(value['rootfs']);
  if (
    !host ||
    !rootfs ||
    typeof value['status'] !== 'string' ||
    typeof value['guestName'] !== 'string' ||
    typeof value['guestPath'] !== 'string' ||
    typeof value['hostPath'] !== 'string' ||
    typeof value['mounted'] !== 'boolean'
  ) {
    return null;
  }
  const staleDaemons = Array.isArray(value['staleDaemons'])
    ? value['staleDaemons'].flatMap((daemon) =>
        isRecord(daemon) &&
        typeof daemon['name'] === 'string' &&
        typeof daemon['pid'] === 'number'
          ? [{ name: daemon['name'], pid: daemon['pid'] }]
          : [],
      )
    : [];
  return {
    status: value['status'],
    guestName: value['guestName'],
    guestPath: value['guestPath'],
    hostPath: value['hostPath'],
    mounted: value['mounted'],
    host,
    rootfs,
    staleDaemons,
    ...(typeof value['recommendedResolution'] === 'string'
      ? { recommendedResolution: value['recommendedResolution'] }
      : {}),
  };
}

function formatStorageBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(2)} GiB`;
}

function formatStorageTimestamp(value: string | undefined): string {
  if (!value) return 'no entries';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: 'short',
        timeStyle: 'medium',
      }).format(date);
}

const activeStatuses = new Set<JobStatus>([
  'queued',
  'running',
  'waiting_input',
]);

function isJobSummary(value: unknown): value is JobSummary {
  if (typeof value !== 'object' || value === null) return false;
  const job = value as Record<string, unknown>;
  return (
    typeof job['id'] === 'string' &&
    typeof job['hostId'] === 'string' &&
    typeof job['type'] === 'string' &&
    typeof job['status'] === 'string'
  );
}

function statusClass(status: JobStatus): string {
  if (status === 'completed')
    return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300';
  if (status === 'failed' || status === 'interrupted')
    return 'bg-red-500/15 text-red-700 dark:text-red-300';
  if (status === 'cancelled') return 'bg-muted text-muted-foreground';
  if (status === 'waiting_input')
    return 'bg-amber-500/15 text-amber-700 dark:text-amber-300';
  return 'bg-sky-500/15 text-sky-700 dark:text-sky-300';
}

function formatTime(value: string | undefined): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date(value));
}

function errorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return fallback;
}

function mergeLogLines(
  current: readonly JobLogEvent[],
  additions: readonly JobLogEvent[],
): JobLogEvent[] {
  const lines = new Map(current.map((line) => [line.seq, line]));
  for (const line of additions) lines.set(line.seq, line);
  return [...lines.values()].sort((left, right) => left.seq - right.seq);
}

function PromptModal({
  prompt,
  busy,
  error,
  canUnlockVault,
  onResolve,
  onUnlockVault,
}: {
  readonly prompt: JobPrompt;
  readonly busy: boolean;
  readonly error: string | null;
  readonly canUnlockVault: boolean;
  readonly onResolve: (resolution: PromptResolution) => Promise<void>;
  readonly onUnlockVault: (
    details: VaultUnlockPromptDetails,
    token: string,
  ) => Promise<void>;
}) {
  const [typedText, setTypedText] = useState('');
  const [vaultToken, setVaultToken] = useState('');
  const storage = parseStoragePrompt(prompt.payload);
  const vaultUnlock = parseVaultUnlockPrompt(prompt.payload);
  useEffect(() => {
    setTypedText('');
    setVaultToken('');
  }, [prompt.id]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-3 sm:items-center">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="job-prompt-title"
        className="w-full max-w-lg rounded-xl border border-border bg-background p-5 shadow-2xl"
      >
        <p className="text-xs font-semibold tracking-wide text-amber-600 uppercase dark:text-amber-300">
          Job waiting for input
        </p>
        <h2 id="job-prompt-title" className="mt-2 text-lg font-semibold">
          {prompt.message}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {prompt.hostId}
          {prompt.vmid !== undefined ? ` · guest ${prompt.vmid}` : ''}
        </p>
        {error && (
          <p className="mt-3 rounded-md bg-red-500/10 p-2 text-sm text-red-700 dark:text-red-300">
            {error}
          </p>
        )}
        {storage && (
          <div className="mt-4 space-y-3 rounded-md border bg-muted/40 p-3 text-sm">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Storage {storage.status.replaceAll('-', ' ')} · mp0{' '}
              {storage.mounted ? 'mounted' : 'not mounted'}
            </p>
            <p className="font-mono text-xs break-all">
              {storage.guestPath} ← {storage.hostPath}
            </p>
            <dl className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  ['Host data', storage.host],
                  ['Rootfs copy', storage.rootfs],
                ] as const
              ).map(([label, side]) => (
                <div key={label} className="rounded border bg-background p-2">
                  <dt className="text-xs font-semibold">{label}</dt>
                  <dd className="text-xs text-muted-foreground">
                    {side.exists
                      ? `${side.fileCount} entries · ${formatStorageBytes(side.bytes)}`
                      : 'missing'}
                    <br />
                    Newest: {formatStorageTimestamp(side.newestTimestamp)}
                  </dd>
                </div>
              ))}
            </dl>
            {storage.staleDaemons.length > 0 && (
              <p className="text-xs text-amber-700 dark:text-amber-300">
                Stale mount namespace:{' '}
                {storage.staleDaemons
                  .map((daemon) => `${daemon.name} (pid ${daemon.pid})`)
                  .join(', ')}
              </p>
            )}
            {storage.recommendedResolution && (
              <p className="text-xs text-muted-foreground">
                Recommended:{' '}
                {storageResolutionLabels[storage.recommendedResolution] ??
                  storage.recommendedResolution}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              The losing side is archived and renamed. It is never deleted
              automatically.
            </p>
          </div>
        )}
        {vaultUnlock && (
          <div className="mt-4 rounded-md border bg-muted/40 p-3 text-sm">
            <p className="font-medium">{vaultUnlock.providerName}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {vaultUnlock.helpText}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              The token is validated immediately, held in server memory only,
              and never stored in the job, prompt, audit log, or database.
            </p>
          </div>
        )}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          {prompt.kind === 'choice' &&
            prompt.options.map((option) => (
              <Button
                key={option}
                type="button"
                variant="outline"
                disabled={busy}
                title={
                  storage?.recommendedResolution &&
                  storageResolutionLabels[storage.recommendedResolution] ===
                    option
                    ? 'Recommended by the storage invariant check'
                    : undefined
                }
                onClick={() => {
                  void onResolve({ kind: 'choice', choice: option });
                }}
              >
                {option}
                {storage?.recommendedResolution &&
                  storageResolutionLabels[storage.recommendedResolution] ===
                    option && (
                    <span className="ml-1 text-[10px] font-semibold text-emerald-600 dark:text-emerald-300">
                      recommended
                    </span>
                  )}
              </Button>
            ))}
          {prompt.kind === 'confirm' && !vaultUnlock && (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  void onResolve({ kind: 'confirm', confirmed: false });
                }}
              >
                Cancel
              </Button>
              <Button
                type="button"
                disabled={busy}
                onClick={() => {
                  void onResolve({ kind: 'confirm', confirmed: true });
                }}
              >
                Confirm
              </Button>
            </>
          )}
          {vaultUnlock &&
            (canUnlockVault ? (
              <form
                className="flex w-full flex-col gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void onUnlockVault(vaultUnlock, vaultToken);
                }}
              >
                <label className="text-sm font-medium" htmlFor="vault-token">
                  {vaultUnlock.tokenLabel}
                </label>
                <input
                  id="vault-token"
                  type="password"
                  autoComplete="off"
                  autoFocus
                  value={vaultToken}
                  onChange={(event) => setVaultToken(event.target.value)}
                  className="h-10 rounded-md border border-border bg-background px-3 font-mono text-sm"
                />
                <Button
                  type="submit"
                  disabled={busy || vaultToken.trim().length === 0}
                >
                  Unlock and resume
                </Button>
              </form>
            ) : (
              <p className="w-full rounded-md bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
                An administrator must unlock this provider before the job can
                continue.
              </p>
            ))}
          {prompt.kind === 'typed_confirmation' && (
            <form
              className="flex w-full flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void onResolve({
                  kind: 'typed_confirmation',
                  text: typedText,
                });
              }}
            >
              <label
                className="text-sm font-medium"
                htmlFor="typed-confirmation"
              >
                Type the requested confirmation exactly
              </label>
              <input
                id="typed-confirmation"
                autoFocus
                value={typedText}
                onChange={(event) => setTypedText(event.target.value)}
                className="h-10 rounded-md border border-border bg-background px-3 font-mono text-sm"
              />
              <Button type="submit" disabled={busy || typedText.length === 0}>
                Submit confirmation
              </Button>
            </form>
          )}
        </div>
      </section>
    </div>
  );
}

export function JobsPage() {
  const { user } = useAuth();
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    job: JobSummary;
    steps: JobStep[];
    prompts: JobPrompt[];
  } | null>(null);
  const [logs, setLogs] = useState<JobLogEvent[]>([]);
  const [pendingPrompts, setPendingPrompts] = useState<JobPrompt[]>([]);
  const [hostFilter, setHostFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [promptBusy, setPromptBusy] = useState(false);
  const [promptError, setPromptError] = useState<string | null>(null);

  const loadJobs = useCallback(async () => {
    const { data, error: apiError } = await apiClient.GET('/api/jobs', {
      params: {
        query: {
          ...(hostFilter ? { hostId: hostFilter } : {}),
          ...(statusFilter ? { status: statusFilter as JobStatus } : {}),
          limit: 1_000,
        },
      },
    });
    if (apiError || !data)
      throw new Error(errorMessage(apiError, 'Could not load jobs.'));
    setJobs(data.jobs as JobSummary[]);
    setSelectedJobId((current) => current ?? data.jobs[0]?.id ?? null);
  }, [hostFilter, statusFilter]);

  const loadPrompts = useCallback(async () => {
    const { data, error: apiError } = await apiClient.GET('/api/prompts');
    if (apiError || !data) {
      throw new Error(
        errorMessage(apiError, 'Could not load pending prompts.'),
      );
    }
    setPendingPrompts(data.prompts as JobPrompt[]);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await Promise.all([loadJobs(), loadPrompts()]);
      setError(null);
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : String(refreshError),
      );
    } finally {
      setLoading(false);
    }
  }, [loadJobs, loadPrompts]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadDetail = useCallback(async (jobId: string) => {
    const { data, error: apiError } = await apiClient.GET('/api/jobs/{jobId}', {
      params: { path: { jobId } },
    });
    if (apiError || !data)
      throw new Error(errorMessage(apiError, 'Could not load job.'));
    setDetail({
      job: data.job as JobSummary,
      steps: data.steps as JobStep[],
      prompts: data.prompts as JobPrompt[],
    });

    const allLogs: JobLogEvent[] = [];
    let cursor = 0;
    for (let page = 0; page < 25; page++) {
      const response = await apiClient.GET('/api/jobs/{jobId}/logs', {
        params: { path: { jobId }, query: { after: cursor, limit: 2_000 } },
      });
      if (response.error || !response.data) {
        throw new Error(
          errorMessage(response.error, 'Could not load job logs.'),
        );
      }
      const pageLogs = response.data.logs as JobLogEvent[];
      allLogs.push(...pageLogs);
      if (pageLogs.length < 2_000) break;
      cursor = response.data.nextCursor;
    }
    setLogs(mergeLogLines([], allLogs));
  }, []);

  useEffect(() => {
    if (!selectedJobId) {
      setDetail(null);
      setLogs([]);
      return;
    }
    void loadDetail(selectedJobId).catch((detailError: unknown) => {
      setError(
        detailError instanceof Error
          ? detailError.message
          : String(detailError),
      );
    });
  }, [loadDetail, selectedJobId]);

  const updateJob = useCallback((value: unknown) => {
    if (!isJobSummary(value)) return;
    setJobs((current) => {
      const found = current.some((job) => job.id === value.id);
      const next = found
        ? current.map((job) =>
            job.id === value.id ? { ...job, ...value } : job,
          )
        : [value, ...current];
      return next.sort(
        (left, right) =>
          new Date(right.createdAt).getTime() -
          new Date(left.createdAt).getTime(),
      );
    });
    setDetail((current) =>
      current?.job.id === value.id
        ? { ...current, job: { ...current.job, ...value } }
        : current,
    );
  }, []);

  const reloadPromptsFromEvent = useCallback(() => {
    void loadPrompts().catch((promptLoadError: unknown) => {
      setError(
        promptLoadError instanceof Error
          ? promptLoadError.message
          : String(promptLoadError),
      );
    });
  }, [loadPrompts]);

  const queueEvents = useQueueEvents({
    onJob: updateJob,
    onPrompt: reloadPromptsFromEvent,
  });
  const jobEvents = useJobEvents(selectedJobId, {
    onLog: (line) => setLogs((current) => mergeLogLines(current, [line])),
    onJob: updateJob,
    onPrompt: reloadPromptsFromEvent,
  });

  const hosts = useMemo(
    () => [...new Set(jobs.map((job) => job.hostId))].sort(),
    [jobs],
  );
  const queues = useMemo(
    () =>
      hosts.map((hostId) => ({
        hostId,
        active: jobs.filter(
          (job) => job.hostId === hostId && activeStatuses.has(job.status),
        ).length,
        waiting: jobs.filter(
          (job) => job.hostId === hostId && job.status === 'waiting_input',
        ).length,
      })),
    [hosts, jobs],
  );

  const cancelSelected = async () => {
    if (!selectedJobId) return;
    const { data, error: apiError } = await apiClient.POST(
      '/api/jobs/{jobId}/cancel',
      { params: { path: { jobId: selectedJobId } } },
    );
    if (apiError || !data) {
      setError(errorMessage(apiError, 'Could not cancel the job.'));
      return;
    }
    updateJob(data.job);
  };

  const resolvePrompt = async (resolution: PromptResolution) => {
    const prompt = pendingPrompts[0];
    if (!prompt) return;
    setPromptBusy(true);
    setPromptError(null);
    try {
      const { error: apiError } = await apiClient.POST(
        '/api/prompts/{promptId}/resolve',
        {
          params: { path: { promptId: prompt.id } },
          body: resolution,
        },
      );
      if (apiError)
        throw new Error(errorMessage(apiError, 'Could not resolve prompt.'));
      await loadPrompts();
      if (selectedJobId === prompt.jobId) await loadDetail(prompt.jobId);
    } catch (resolveError) {
      setPromptError(
        resolveError instanceof Error
          ? resolveError.message
          : String(resolveError),
      );
    } finally {
      setPromptBusy(false);
    }
  };

  const unlockVault = async (
    details: VaultUnlockPromptDetails,
    token: string,
  ) => {
    const prompt = pendingPrompts[0];
    if (!prompt) return;
    setPromptBusy(true);
    setPromptError(null);
    try {
      const unlockResponse = await apiClient.POST(
        '/api/hosts/{hostId}/vault/providers/{providerId}/unlock',
        {
          params: {
            path: {
              hostId: prompt.hostId,
              providerId: details.providerId,
            },
          },
          body: { token },
        },
      );
      if (unlockResponse.error) {
        throw new Error(
          errorMessage(unlockResponse.error, 'Could not unlock the vault.'),
        );
      }
      const resolution = await apiClient.POST(
        '/api/prompts/{promptId}/resolve',
        {
          params: { path: { promptId: prompt.id } },
          body: { kind: 'confirm', confirmed: true },
        },
      );
      if (resolution.error) {
        throw new Error(
          errorMessage(resolution.error, 'Could not resume the job.'),
        );
      }
      await loadPrompts();
      if (selectedJobId === prompt.jobId) await loadDetail(prompt.jobId);
    } catch (unlockError) {
      setPromptError(
        unlockError instanceof Error
          ? unlockError.message
          : String(unlockError),
      );
    } finally {
      setPromptBusy(false);
    }
  };

  const selected = detail?.job ?? jobs.find((job) => job.id === selectedJobId);
  const canCancel =
    user?.role !== 'viewer' && selected && activeStatuses.has(selected.status);

  return (
    <section className="space-y-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Jobs &amp; Queue</h1>
          <p className="text-sm text-muted-foreground">
            Durable work, live logs, and decisions from every signed-in device.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'rounded-full px-2 py-1 text-xs font-medium',
              queueEvents.connected
                ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                : 'bg-muted text-muted-foreground',
            )}
          >
            {queueEvents.connected ? 'Live' : 'Reconnecting'}
          </span>
          <Button
            type="button"
            variant="outline"
            onClick={() => void refresh()}
          >
            <RefreshCw aria-hidden className="h-4 w-4" />
            Refresh
          </Button>
        </div>
      </header>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {queues.map((queue) => (
          <button
            key={queue.hostId}
            type="button"
            aria-label={`Filter queue for ${queue.hostId}`}
            className={cn(
              'rounded-lg border border-border p-3 text-left transition-colors hover:bg-accent',
              hostFilter === queue.hostId && 'border-primary bg-accent',
            )}
            onClick={() =>
              setHostFilter((current) =>
                current === queue.hostId ? '' : queue.hostId,
              )
            }
          >
            <span className="font-medium">{queue.hostId}</span>
            <span className="mt-1 block text-xs text-muted-foreground">
              {queue.active} active · {queue.waiting} waiting
            </span>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <select
          aria-label="Filter by host"
          value={hostFilter}
          onChange={(event) => setHostFilter(event.target.value)}
          className="h-9 rounded-md border border-border bg-background px-3 text-sm"
        >
          <option value="">All hosts</option>
          {hosts.map((host) => (
            <option key={host} value={host}>
              {host}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by status"
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
          className="h-9 rounded-md border border-border bg-background px-3 text-sm"
        >
          <option value="">All statuses</option>
          {[
            ...activeStatuses,
            'completed',
            'failed',
            'cancelled',
            'interrupted',
          ].map((status) => (
            <option key={status} value={status}>
              {status.replace('_', ' ')}
            </option>
          ))}
        </select>
      </div>

      <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(18rem,0.8fr)_minmax(0,2fr)]">
        <aside className="max-h-[70vh] overflow-auto rounded-xl border border-border">
          {loading && jobs.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">Loading jobs…</p>
          ) : jobs.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              No jobs match these filters.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {jobs.map((job) => (
                <li key={job.id}>
                  <button
                    type="button"
                    className={cn(
                      'w-full p-3 text-left hover:bg-accent',
                      selectedJobId === job.id && 'bg-accent',
                    )}
                    onClick={() => setSelectedJobId(job.id)}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="truncate font-medium">{job.type}</span>
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 text-[11px] font-medium',
                          statusClass(job.status),
                        )}
                      >
                        {job.status.replace('_', ' ')}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {job.hostId}
                      {job.vmid !== undefined
                        ? ` · guest ${job.vmid}`
                        : ' · host lane'}
                      {job.reason !== 'manual' ? ` · ${job.reason}` : ''}
                    </p>
                    <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                      {job.id}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <article className="min-w-0 space-y-4">
          {!selected ? (
            <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              Select a job to inspect its progress.
            </div>
          ) : (
            <>
              <div className="rounded-xl border border-border p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-lg font-semibold">{selected.type}</h2>
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 text-xs font-medium',
                          statusClass(selected.status),
                        )}
                      >
                        {selected.status.replace('_', ' ')}
                      </span>
                    </div>
                    <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                      {selected.id}
                    </p>
                  </div>
                  {canCancel && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void cancelSelected()}
                    >
                      <XCircle aria-hidden className="h-4 w-4" />
                      Cancel job
                    </Button>
                  )}
                </div>
                <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                  <div>
                    <dt className="text-xs text-muted-foreground">Target</dt>
                    <dd>
                      {selected.hostId}
                      {selected.vmid !== undefined ? ` / ${selected.vmid}` : ''}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Created</dt>
                    <dd>{formatTime(selected.createdAt)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Started</dt>
                    <dd>{formatTime(selected.startedAt)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      Live stream
                    </dt>
                    <dd className="flex items-center gap-1.5">
                      {jobEvents.connected ? (
                        <CirclePlay className="h-4 w-4 text-emerald-500" />
                      ) : (
                        <CirclePause className="h-4 w-4 text-muted-foreground" />
                      )}
                      {jobEvents.connected ? 'connected' : 'reconnecting'}
                    </dd>
                  </div>
                </dl>
                {selected.error && (
                  <p className="mt-4 rounded-md bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
                    {selected.error}
                  </p>
                )}
              </div>

              {detail && detail.steps.length > 0 && (
                <section className="rounded-xl border border-border p-4">
                  <h3 className="font-semibold">Journaled steps</h3>
                  <ol className="mt-3 space-y-2">
                    {detail.steps.map((step) => (
                      <li
                        key={step.stepIndex}
                        className="flex items-start gap-3 rounded-md bg-muted/50 p-3 text-sm"
                      >
                        <Clock3
                          aria-hidden
                          className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium">{step.name}</span>
                            <span className="text-xs text-muted-foreground">
                              {step.status}
                            </span>
                          </div>
                          {step.rollbackHint && (
                            <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                              {step.rollbackHint}
                            </p>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                </section>
              )}

              <section>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="font-semibold">Live log</h3>
                  <span className="text-xs text-muted-foreground">
                    {logs.length.toLocaleString()} lines
                  </span>
                </div>
                <VirtualLogViewer lines={logs} />
              </section>
            </>
          )}
        </article>
      </div>

      {pendingPrompts[0] && (
        <PromptModal
          prompt={pendingPrompts[0]}
          busy={promptBusy}
          error={promptError}
          canUnlockVault={user?.role === 'admin'}
          onResolve={resolvePrompt}
          onUnlockVault={unlockVault}
        />
      )}
    </section>
  );
}

export const jobsPageInternals = {
  isJobSummary,
  statusClass,
  formatTime,
  errorMessage,
  mergeLogLines,
  parseStoragePrompt,
  parseVaultUnlockPrompt,
  formatStorageBytes,
  formatStorageTimestamp,
};

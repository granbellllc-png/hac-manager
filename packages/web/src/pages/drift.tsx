import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  GitCompareArrows,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import { apiClient } from '../api/client';
import type { paths } from '../api/schema';
import { useAuth } from '../auth/auth-context';
import { Button } from '../components/ui/button';
import { cn } from '../lib/utils';

type DriftSnapshot =
  paths['/api/drift']['get']['responses']['200']['content']['application/json']['snapshots'][number];
type DriftChange = DriftSnapshot['changes'][number];
type Host =
  paths['/api/hosts']['get']['responses']['200']['content']['application/json']['hosts'][number];
type Guest =
  paths['/api/inventory/guests']['get']['responses']['200']['content']['application/json']['guests'][number];

type ActionKind = 'check' | 'host-check' | 'pull' | 'enforce';

interface ConfirmationPrompt {
  readonly key: string;
  readonly expectedText: string;
}

function snapshotKey(snapshot: {
  readonly hostId: string;
  readonly vmid: number;
}): string {
  return `${snapshot.hostId}:${snapshot.vmid}`;
}

function guestLabel(
  snapshot: DriftSnapshot,
  guestNames: ReadonlyMap<string, string>,
): string {
  return guestNames.get(snapshotKey(snapshot)) ?? `Guest ${snapshot.vmid}`;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value, null, 2);
}

function canPull(change: DriftChange): boolean {
  return change.pullable && change.kind !== 'missing_in_live';
}

function statusClass(status: DriftSnapshot['status']): string {
  return status === 'drifted'
    ? 'border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400'
    : 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400';
}

function notPullableReason(change: DriftChange): string | undefined {
  if (change.secret)
    return 'Secret values are compared by hash and cannot be pulled.';
  if (change.computed) {
    return 'This field is produced by a tag and is computed, not editable YAML.';
  }
  if (change.kind === 'missing_in_live') {
    return 'The field is absent from live state; removing YAML keys is not supported.';
  }
  if (!change.pullable) return 'This field cannot be pulled from live state.';
  return undefined;
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    if ('message' in error && typeof error.message === 'string') {
      return error.message;
    }
    if (
      'error' in error &&
      typeof error.error === 'string' &&
      'statusCode' in error
    ) {
      return error.error;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

function errorConfirmation(error: unknown): string | undefined {
  if (
    error &&
    typeof error === 'object' &&
    'confirmationText' in error &&
    typeof error.confirmationText === 'string'
  ) {
    return error.confirmationText;
  }
  return undefined;
}

export function DriftPage() {
  const { user } = useAuth();
  const [snapshots, setSnapshots] = useState<readonly DriftSnapshot[]>([]);
  const [hosts, setHosts] = useState<readonly Host[]>([]);
  const [guests, setGuests] = useState<readonly Guest[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [hostFilter, setHostFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<
    Readonly<Record<string, readonly string[]>>
  >({});
  const [busy, setBusy] = useState<Readonly<Record<string, ActionKind>>>({});
  const [confirmation, setConfirmation] = useState<ConfirmationPrompt | null>(
    null,
  );
  const [confirmationText, setConfirmationText] = useState('');

  const canResolve = user?.role !== 'viewer';

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [driftResult, hostResult, guestResult] = await Promise.all([
        apiClient.GET('/api/drift'),
        apiClient.GET('/api/hosts'),
        apiClient.GET('/api/inventory/guests'),
      ]);
      if (driftResult.error || !driftResult.data) {
        setError('Unable to load drift snapshots.');
        return;
      }
      setSnapshots(driftResult.data.snapshots);
      setHosts(hostResult.data?.hosts ?? []);
      setGuests(guestResult.data?.guests ?? []);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : String(loadError),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const hostNames = useMemo(
    () => new Map(hosts.map((host) => [host.id, host.name])),
    [hosts],
  );
  const guestNames = useMemo(
    () =>
      new Map(
        guests.map((guest) => [`${guest.hostId}:${guest.vmid}`, guest.name]),
      ),
    [guests],
  );

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return [...snapshots]
      .filter((snapshot) => {
        const label = guestLabel(snapshot, guestNames).toLowerCase();
        return (
          (!hostFilter || snapshot.hostId === hostFilter) &&
          (!statusFilter || snapshot.status === statusFilter) &&
          (needle.length === 0 ||
            label.includes(needle) ||
            String(snapshot.vmid).includes(needle) ||
            snapshot.hostId.toLowerCase().includes(needle))
        );
      })
      .sort(
        (a, b) =>
          a.hostId.localeCompare(b.hostId) ||
          a.vmid - b.vmid ||
          a.checkedAt.localeCompare(b.checkedAt),
      );
  }, [guestNames, hostFilter, search, snapshots, statusFilter]);

  const groups = useMemo(() => {
    const map = new Map<string, DriftSnapshot[]>();
    for (const snapshot of filtered) {
      const list = map.get(snapshot.hostId) ?? [];
      list.push(snapshot);
      map.set(snapshot.hostId, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  const driftedCount = snapshots.filter(
    (snapshot) => snapshot.status === 'drifted',
  ).length;
  const pullableCount = snapshots.reduce(
    (count, snapshot) =>
      count + snapshot.changes.filter((change) => canPull(change)).length,
    0,
  );
  const nonPullableCount = snapshots.reduce(
    (count, snapshot) =>
      count + snapshot.changes.filter((change) => !canPull(change)).length,
    0,
  );

  const updateSnapshot = (snapshot: DriftSnapshot) => {
    setSnapshots((current) => {
      const key = snapshotKey(snapshot);
      const next = current.filter((entry) => snapshotKey(entry) !== key);
      next.push(snapshot);
      return next;
    });
    setSelected((current) => {
      const next = { ...current };
      delete next[snapshotKey(snapshot)];
      return next;
    });
  };

  const toggleExpanded = (key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectedPaths = (snapshot: DriftSnapshot): readonly string[] =>
    selected[snapshotKey(snapshot)] ?? [];

  const setSelectedPaths = (
    snapshot: DriftSnapshot,
    paths: readonly string[],
  ) => {
    setSelected((current) => {
      const next = { ...current };
      if (paths.length === 0) delete next[snapshotKey(snapshot)];
      else next[snapshotKey(snapshot)] = paths;
      return next;
    });
  };

  const togglePath = (snapshot: DriftSnapshot, path: string) => {
    const current = new Set(selectedPaths(snapshot));
    if (current.has(path)) current.delete(path);
    else current.add(path);
    setSelectedPaths(snapshot, [...current]);
  };

  const toggleAllPullable = (snapshot: DriftSnapshot) => {
    const pullable = snapshot.changes
      .filter((change) => canPull(change))
      .map((change) => change.path);
    const current = selectedPaths(snapshot);
    setSelectedPaths(
      snapshot,
      pullable.length > 0 && current.length === pullable.length ? [] : pullable,
    );
  };

  const checkGuest = async (snapshot: DriftSnapshot) => {
    const key = snapshotKey(snapshot);
    setBusy((current) => ({ ...current, [key]: 'check' }));
    setError(null);
    setMessage(null);
    try {
      const result = await apiClient.POST('/api/drift/{hostId}/{vmid}/check', {
        params: {
          path: { hostId: snapshot.hostId, vmid: snapshot.vmid },
        },
      });
      if (result.error || !result.data) {
        setError(errorMessage(result.error));
        return;
      }
      updateSnapshot(result.data);
      setMessage(`Checked ${guestLabel(result.data, guestNames)}.`);
    } catch (checkError) {
      setError(errorMessage(checkError));
    } finally {
      setBusy((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    }
  };

  const checkHost = async (hostId: string) => {
    const key = `host:${hostId}`;
    setBusy((current) => ({ ...current, [key]: 'host-check' }));
    setError(null);
    setMessage(null);
    try {
      const result = await apiClient.POST('/api/drift/hosts/{hostId}/check', {
        params: { path: { hostId } },
      });
      if (result.error || !result.data) {
        setError(errorMessage(result.error));
        return;
      }
      setSnapshots((current) => {
        const byKey = new Map(
          result.data.snapshots.map((snapshot) => [
            snapshotKey(snapshot),
            snapshot,
          ]),
        );
        const merged = current.map(
          (snapshot) => byKey.get(snapshotKey(snapshot)) ?? snapshot,
        );
        for (const snapshot of result.data.snapshots) {
          if (
            !current.some(
              (entry) => snapshotKey(entry) === snapshotKey(snapshot),
            )
          ) {
            merged.push(snapshot);
          }
        }
        return merged;
      });
      setMessage(
        `Checked ${result.data.checked} guest${result.data.checked === 1 ? '' : 's'} on ${hostNames.get(hostId) ?? hostId}${result.data.failures.length > 0 ? `; ${result.data.failures.length} failed` : ''}.`,
      );
    } catch (checkError) {
      setError(errorMessage(checkError));
    } finally {
      setBusy((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    }
  };

  const pull = async (snapshot: DriftSnapshot, paths?: readonly string[]) => {
    const key = snapshotKey(snapshot);
    setBusy((current) => ({ ...current, [key]: 'pull' }));
    setError(null);
    setMessage(null);
    try {
      const result = await apiClient.POST('/api/drift/{hostId}/{vmid}/pull', {
        params: {
          path: { hostId: snapshot.hostId, vmid: snapshot.vmid },
        },
        body: paths ? { paths: [...paths] } : {},
      });
      if (result.error || !result.data) {
        setError(errorMessage(result.error));
        return;
      }
      updateSnapshot(result.data.snapshot);
      const failures = result.data.failures.length;
      setMessage(
        `Pulled ${result.data.applied.length} field${result.data.applied.length === 1 ? '' : 's'} into YAML for ${guestLabel(snapshot, guestNames)}${failures > 0 ? `; ${failures} field${failures === 1 ? '' : 's'} could not be pulled` : ''}.`,
      );
    } catch (pullError) {
      setError(errorMessage(pullError));
    } finally {
      setBusy((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    }
  };

  const enforce = async (
    snapshot: DriftSnapshot,
    confirmationValue?: string,
  ) => {
    const key = snapshotKey(snapshot);
    setBusy((current) => ({ ...current, [key]: 'enforce' }));
    setError(null);
    setMessage(null);
    try {
      const result = await apiClient.POST(
        '/api/drift/{hostId}/{vmid}/enforce',
        {
          params: {
            path: { hostId: snapshot.hostId, vmid: snapshot.vmid },
          },
          body: confirmationValue ? { confirmation: confirmationValue } : {},
        },
      );
      if (result.error || !result.data) {
        const expectedText = errorConfirmation(result.error);
        if (expectedText) {
          setConfirmation({ key, expectedText });
          setConfirmationText('');
          return;
        }
        setError(errorMessage(result.error));
        return;
      }
      setConfirmation(null);
      setConfirmationText('');
      setMessage(
        `Queued plan ${result.data.plan.id} in job ${result.data.job.id} for ${guestLabel(snapshot, guestNames)}.`,
      );
    } catch (enforceError) {
      setError(errorMessage(enforceError));
    } finally {
      setBusy((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    }
  };

  return (
    <section className="flex flex-col gap-6" aria-label="Drift and sync center">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Drift &amp; Sync Center
          </h1>
          <p className="text-sm text-muted-foreground">
            Compare evaluated YAML with live guests. Enforce YAML or pull live
            values back through the comment-preserving writeback layer.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={refreshing || loading}
          onClick={() => {
            setRefreshing(true);
            void load().finally(() => {
              setRefreshing(false);
            });
          }}
        >
          <RefreshCw
            aria-hidden
            className={cn('mr-2 h-4 w-4', refreshing && 'animate-spin')}
          />
          Refresh snapshots
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <SummaryCard label="Drifted guests" value={driftedCount} tone="amber" />
        <SummaryCard
          label="Pullable fields"
          value={pullableCount}
          tone="emerald"
        />
        <SummaryCard
          label="Protected fields"
          value={nonPullableCount}
          tone="muted"
        />
      </div>

      <div className="grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">
          Search
          <input
            aria-label="Search drift"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
            placeholder="Guest, VMID, or host"
            className="h-9 rounded-md border border-border bg-background px-3 text-sm text-foreground"
          />
        </label>
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">
          Host
          <select
            aria-label="Filter drift by host"
            value={hostFilter}
            onChange={(event) => {
              setHostFilter(event.target.value);
            }}
            className="h-9 rounded-md border border-border bg-background px-3 text-sm text-foreground"
          >
            <option value="">All hosts</option>
            {hosts.map((host) => (
              <option key={host.id} value={host.id}>
                {host.name}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">
          Status
          <select
            aria-label="Filter drift by status"
            value={statusFilter}
            onChange={(event) => {
              setStatusFilter(event.target.value);
            }}
            className="h-9 rounded-md border border-border bg-background px-3 text-sm text-foreground"
          >
            <option value="">All statuses</option>
            <option value="drifted">Drifted</option>
            <option value="in_sync">In sync</option>
          </select>
        </label>
        <div className="flex items-end">
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => {
              setSearch('');
              setHostFilter('');
              setStatusFilter('');
            }}
          >
            Reset filters
          </Button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-600 dark:text-rose-400"
        >
          {error}
        </div>
      )}
      {message && (
        <div
          role="status"
          className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-600 dark:text-emerald-400"
        >
          {message}
        </div>
      )}

      {loading ? (
        <div className="flex flex-col gap-3">
          {[1, 2, 3].map((item) => (
            <div
              key={item}
              className="h-28 animate-pulse rounded-lg border bg-muted"
            />
          ))}
        </div>
      ) : groups.length === 0 ? (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <GitCompareArrows
            aria-hidden
            className="mx-auto mb-3 h-10 w-10 text-muted-foreground"
          />
          <h2 className="font-semibold">No drift snapshots match</h2>
          <p className="text-sm text-muted-foreground">
            Run a drift check on a host or change the filters.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map(([hostId, hostSnapshots]) => {
            const hostBusy = busy[`host:${hostId}`];
            return (
              <section
                key={hostId}
                aria-label={`Drift on ${hostNames.get(hostId) ?? hostId}`}
                className="flex flex-col gap-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="text-lg font-semibold">
                      {hostNames.get(hostId) ?? hostId}
                    </h2>
                    <p className="text-xs text-muted-foreground">
                      {hostSnapshots.length} guest
                      {hostSnapshots.length === 1 ? '' : 's'} with snapshots
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={Boolean(hostBusy) || !canResolve}
                    onClick={() => void checkHost(hostId)}
                  >
                    <RefreshCw
                      aria-hidden
                      className={cn(
                        'mr-2 h-3.5 w-3.5',
                        hostBusy === 'host-check' && 'animate-spin',
                      )}
                    />
                    Check host
                  </Button>
                </div>

                <div className="flex flex-col gap-3">
                  {hostSnapshots.map((snapshot) => {
                    const key = snapshotKey(snapshot);
                    const isExpanded = expanded.has(key);
                    const paths = selectedPaths(snapshot);
                    const pullable = snapshot.changes.filter((change) =>
                      canPull(change),
                    );
                    const allSelected =
                      pullable.length > 0 &&
                      paths.length === pullable.length &&
                      pullable.every((change) => paths.includes(change.path));
                    const action = busy[key];
                    const prompt =
                      confirmation?.key === key ? confirmation : null;
                    const label = guestLabel(snapshot, guestNames);

                    return (
                      <article
                        key={key}
                        aria-label={label}
                        className="rounded-lg border bg-card shadow-sm"
                      >
                        <div className="flex flex-col gap-3 p-4 lg:flex-row lg:items-start lg:justify-between">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <h3 className="truncate font-semibold">
                                {label}
                              </h3>
                              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                                {snapshot.vmid}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                {snapshot.type.toUpperCase()}
                              </span>
                              <span
                                className={cn(
                                  'rounded-full border px-2 py-0.5 text-xs font-medium',
                                  statusClass(snapshot.status),
                                )}
                              >
                                {snapshot.status === 'drifted'
                                  ? 'Drifted'
                                  : 'In sync'}
                              </span>
                            </div>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {snapshot.changes.length} change
                              {snapshot.changes.length === 1 ? '' : 's'} ·{' '}
                              checked{' '}
                              {new Date(snapshot.checkedAt).toLocaleString()}
                            </p>
                          </div>

                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={Boolean(action)}
                              onClick={() => void checkGuest(snapshot)}
                            >
                              {action === 'check' ? 'Checking…' : 'Check'}
                            </Button>
                            {snapshot.status === 'drifted' && (
                              <Button
                                size="sm"
                                disabled={!canResolve || Boolean(action)}
                                onClick={() => void enforce(snapshot)}
                              >
                                <ShieldAlert
                                  aria-hidden
                                  className="mr-2 h-3.5 w-3.5"
                                />
                                Enforce
                              </Button>
                            )}
                            {pullable.length > 0 && (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={!canResolve || Boolean(action)}
                                onClick={() =>
                                  void pull(
                                    snapshot,
                                    paths.length > 0 ? paths : undefined,
                                  )
                                }
                              >
                                {paths.length > 0
                                  ? `Pull selected (${paths.length})`
                                  : 'Pull all'}
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-expanded={isExpanded}
                              onClick={() => {
                                toggleExpanded(key);
                              }}
                            >
                              {isExpanded ? (
                                <ChevronDown
                                  aria-hidden
                                  className="mr-2 h-4 w-4"
                                />
                              ) : (
                                <ChevronRight
                                  aria-hidden
                                  className="mr-2 h-4 w-4"
                                />
                              )}
                              {isExpanded ? 'Hide diff' : 'Show diff'}
                            </Button>
                          </div>
                        </div>

                        {prompt && (
                          <div
                            role="dialog"
                            aria-label={`Confirm enforce for ${label}`}
                            className="mx-4 mb-4 rounded-md border border-amber-500/30 bg-amber-500/10 p-3"
                          >
                            <p className="text-sm">
                              This update needs typed confirmation. Type{' '}
                              <code className="font-mono font-semibold">
                                {prompt.expectedText}
                              </code>
                            </p>
                            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                              <input
                                aria-label="Confirmation text"
                                value={confirmationText}
                                onChange={(event) => {
                                  setConfirmationText(event.target.value);
                                }}
                                className="h-9 flex-1 rounded-md border border-border bg-background px-3 font-mono text-sm text-foreground"
                              />
                              <Button
                                size="sm"
                                disabled={
                                  confirmationText !== prompt.expectedText ||
                                  Boolean(action)
                                }
                                onClick={() => {
                                  void enforce(snapshot, confirmationText);
                                }}
                              >
                                Confirm enforce
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  setConfirmation(null);
                                  setConfirmationText('');
                                }}
                              >
                                Cancel
                              </Button>
                            </div>
                          </div>
                        )}

                        {isExpanded && (
                          <div className="border-t px-4 pb-4">
                            {snapshot.changes.length === 0 ? (
                              <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                                <CheckCircle2
                                  aria-hidden
                                  className="h-4 w-4 text-emerald-500"
                                />
                                YAML and live state match.
                              </p>
                            ) : (
                              <>
                                <div className="flex flex-wrap items-center justify-between gap-2 py-3">
                                  <label className="flex items-center gap-2 text-xs font-medium">
                                    <input
                                      type="checkbox"
                                      aria-label={`Select all pullable fields for ${label}`}
                                      checked={allSelected}
                                      disabled={
                                        !canResolve || pullable.length === 0
                                      }
                                      onChange={() => {
                                        toggleAllPullable(snapshot);
                                      }}
                                      className="h-4 w-4 rounded border-border accent-primary"
                                    />
                                    Select all pullable
                                  </label>
                                  {nonPullableCount > 0 && (
                                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                                      <AlertTriangle
                                        aria-hidden
                                        className="h-3.5 w-3.5 text-amber-500"
                                      />
                                      Computed, secret and missing-live fields
                                      cannot be pulled.
                                    </span>
                                  )}
                                </div>

                                <div className="divide-y">
                                  {snapshot.changes.map((change) => (
                                    <DiffRow
                                      key={change.path}
                                      change={change}
                                      checked={paths.includes(change.path)}
                                      disabled={!canResolve}
                                      onToggle={() => {
                                        togglePath(snapshot, change.path);
                                      }}
                                      onPull={() =>
                                        void pull(snapshot, [change.path])
                                      }
                                      pullBusy={Boolean(action)}
                                    />
                                  ))}
                                </div>
                              </>
                            )}
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}

function SummaryCard({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: number;
  readonly tone: 'amber' | 'emerald' | 'muted';
}) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          'mt-1 text-2xl font-semibold',
          tone === 'amber' && 'text-amber-600 dark:text-amber-400',
          tone === 'emerald' && 'text-emerald-600 dark:text-emerald-400',
        )}
      >
        {value}
      </p>
    </div>
  );
}

function DiffRow({
  change,
  checked,
  disabled,
  onToggle,
  onPull,
  pullBusy,
}: {
  readonly change: DriftChange;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onToggle: () => void;
  readonly onPull: () => void;
  readonly pullBusy: boolean;
}) {
  const reason = notPullableReason(change);
  const pullable = canPull(change);
  return (
    <div className="py-3" data-testid={`drift-change-${change.path}`}>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="checkbox"
          aria-label={`Select field ${change.path}`}
          checked={checked}
          disabled={disabled || !pullable}
          onChange={onToggle}
          title={reason}
          className="h-4 w-4 rounded border-border accent-primary"
        />
        <code className="font-mono text-xs font-medium">{change.path}</code>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {change.category}
        </span>
        {change.tag && (
          <span className="rounded border border-sky-500/20 bg-sky-500/10 px-1.5 py-0.5 font-mono text-[10px] text-sky-600 dark:text-sky-400">
            !{change.tag}
          </span>
        )}
        {reason && (
          <span
            title={reason}
            className="inline-flex items-center gap-1 rounded border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
          >
            <AlertTriangle aria-hidden className="h-3 w-3" />
            {change.secret
              ? 'Secret — not pullable'
              : change.computed
                ? 'Computed — not pullable'
                : change.kind === 'missing_in_live'
                  ? 'Missing in live — cannot pull'
                  : 'Not pullable'}
          </span>
        )}
        {pullable && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7 px-2 text-xs"
            disabled={disabled || pullBusy}
            onClick={onPull}
          >
            Pull field
          </Button>
        )}
      </div>

      <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
        <div className="min-w-0 rounded-md border bg-muted/20 p-2">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            YAML
          </p>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs">
            {formatValue(change.desired)}
          </pre>
        </div>
        <div className="min-w-0 rounded-md border bg-muted/20 p-2">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Live
          </p>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs">
            {formatValue(change.actual)}
          </pre>
        </div>
      </div>
      {change.warnings && change.warnings.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs text-amber-600 dark:text-amber-400">
          {change.warnings.map((warning) => (
            <li key={warning} className="flex gap-1">
              <AlertTriangle aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
              {warning}
            </li>
          ))}
        </ul>
      )}
      {change.kind !== 'changed' && (
        <p className="mt-1 text-xs text-muted-foreground">
          {change.kind === 'missing_in_live'
            ? 'The YAML field has no live counterpart.'
            : 'The live guest has a value that is absent from YAML.'}
        </p>
      )}
    </div>
  );
}

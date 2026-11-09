import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  Box,
  Cpu,
  HardDrive,
  MemoryStick,
  RefreshCw,
  Search,
} from 'lucide-react';
import { apiClient } from '../api/client';
import type { paths } from '../api/schema';
import { Button } from '../components/ui/button';

type Guest =
  paths['/api/inventory/guests']['get']['responses']['200']['content']['application/json']['guests'][number];
type Host =
  paths['/api/hosts']['get']['responses']['200']['content']['application/json']['hosts'][number];

const pageSize = 50;

function statusClass(status: string): string {
  if (status === 'running') {
    return 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400';
  }
  if (status === 'stopped') {
    return 'border-border bg-muted text-muted-foreground';
  }
  return 'border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400';
}

function formatBytes(value: number | undefined): string {
  if (value === undefined) return '—';
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

export function ResourcesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [guests, setGuests] = useState<readonly Guest[]>([]);
  const [hosts, setHosts] = useState<readonly Host[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [guestResult, hostResult] = await Promise.all([
        apiClient.GET('/api/inventory/guests'),
        apiClient.GET('/api/hosts'),
      ]);
      if (guestResult.error || !guestResult.data) {
        setError('Unable to load guest resources.');
        return;
      }
      setGuests(guestResult.data.guests);
      setHosts(hostResult.data?.hosts ?? []);
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
  const statuses = useMemo(
    () => [...new Set(guests.map((guest) => guest.status))].sort(),
    [guests],
  );

  const hostFilter = searchParams.get('hostId') ?? '';
  const typeFilter = searchParams.get('type') ?? '';
  const statusFilter = searchParams.get('status') ?? '';
  const configurationFilter = searchParams.get('configuration') ?? '';

  const filteredGuests = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return guests
      .filter((guest) => {
        const matchesSearch =
          needle.length === 0 ||
          guest.name.toLowerCase().includes(needle) ||
          String(guest.vmid).includes(needle) ||
          guest.hostId.toLowerCase().includes(needle) ||
          (hostNames.get(guest.hostId) ?? '').toLowerCase().includes(needle);
        return (
          matchesSearch &&
          (!hostFilter || guest.hostId === hostFilter) &&
          (!typeFilter || guest.type === typeFilter) &&
          (!statusFilter || guest.status === statusFilter) &&
          (!configurationFilter ||
            guest.configuration.status === configurationFilter)
        );
      })
      .sort(
        (a, b) =>
          a.vmid - b.vmid ||
          a.hostId.localeCompare(b.hostId) ||
          a.name.localeCompare(b.name),
      );
  }, [
    configurationFilter,
    guests,
    hostFilter,
    hostNames,
    search,
    statusFilter,
    typeFilter,
  ]);

  const pageCount = Math.max(1, Math.ceil(filteredGuests.length / pageSize));
  const visiblePage = Math.min(page, pageCount);
  const visibleGuests = filteredGuests.slice(
    (visiblePage - 1) * pageSize,
    visiblePage * pageSize,
  );
  const orphanCount = guests.filter(
    (guest) => guest.configuration.status === 'orphan',
  ).length;
  const ignoredCount = guests.filter(
    (guest) => guest.configuration.status === 'ignored',
  ).length;

  const updateFilter = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
    setPage(1);
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      const result = await apiClient.POST('/api/inventory/refresh', {
        body: {},
      });
      if (result.error) {
        setError('Unable to refresh guest inventory.');
        return;
      }
      await load();
    } catch {
      setError('Unable to refresh guest inventory.');
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Resources</h1>
          <p className="text-sm text-muted-foreground">
            Live LXC and VM guests across every granted host.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={refreshing || loading}
          onClick={() => void refresh()}
        >
          <RefreshCw
            aria-hidden
            className={`mr-2 h-4 w-4 ${refreshing ? 'animate-spin' : ''}`}
          />
          Refresh inventory
        </Button>
      </div>

      {orphanCount > 0 && (
        <div
          role="alert"
          className="flex gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-4 text-sm"
        >
          <AlertTriangle
            aria-hidden
            className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400"
          />
          <div>
            <p className="font-medium">
              {orphanCount} live{' '}
              {orphanCount === 1 ? 'guest has' : 'guests have'} no YAML
              definition.
            </p>
            <p className="text-muted-foreground">
              Open an orphan to review it before importing, ignoring or deleting
              it.
              {ignoredCount > 0
                ? ` ${ignoredCount} ignored ${ignoredCount === 1 ? 'guest is' : 'guests are'} recorded in host.yaml.`
                : ''}
            </p>
          </div>
        </div>
      )}

      <section
        aria-label="Resource filters"
        className="grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2 xl:grid-cols-5"
      >
        <label className="grid gap-1 text-xs font-medium text-muted-foreground sm:col-span-2 xl:col-span-1">
          Search
          <span className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-2.5 left-3 h-4 w-4 text-muted-foreground"
            />
            <input
              aria-label="Search resources"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              placeholder="Name, VMID, or host"
              className="h-9 w-full rounded-md border border-border bg-background pr-3 pl-9 text-sm text-foreground"
            />
          </span>
        </label>
        <FilterSelect
          label="Host"
          value={hostFilter}
          onChange={(value) => updateFilter('hostId', value)}
          options={hosts.map((host) => ({ value: host.id, label: host.name }))}
        />
        <FilterSelect
          label="Type"
          value={typeFilter}
          onChange={(value) => updateFilter('type', value)}
          options={[
            { value: 'lxc', label: 'LXC' },
            { value: 'vm', label: 'VM' },
          ]}
        />
        <FilterSelect
          label="Status"
          value={statusFilter}
          onChange={(value) => updateFilter('status', value)}
          options={statuses.map((status) => ({
            value: status,
            label: status[0]?.toUpperCase() + status.slice(1),
          }))}
        />
        <FilterSelect
          label="Configuration"
          value={configurationFilter}
          onChange={(value) => updateFilter('configuration', value)}
          options={[
            { value: 'configured', label: 'Configured' },
            { value: 'orphan', label: 'Orphan' },
            { value: 'ignored', label: 'Ignored' },
          ]}
        />
      </section>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-600 dark:text-rose-400"
        >
          {error}
        </div>
      )}

      {loading ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {[1, 2, 3, 4, 5, 6].map((item) => (
            <div
              key={item}
              className="h-40 animate-pulse rounded-lg border bg-muted"
            />
          ))}
        </div>
      ) : visibleGuests.length === 0 ? (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <Box
            aria-hidden
            className="mx-auto mb-3 h-10 w-10 text-muted-foreground"
          />
          <h2 className="font-semibold">No resources match</h2>
          <p className="text-sm text-muted-foreground">
            Change the filters or refresh live inventory.
          </p>
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground" aria-live="polite">
            Showing {(visiblePage - 1) * pageSize + 1}–
            {Math.min(visiblePage * pageSize, filteredGuests.length)} of{' '}
            {filteredGuests.length} resources
          </p>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {visibleGuests.map((guest) => (
              <article
                key={`${guest.hostId}:${guest.vmid}`}
                className="flex min-w-0 flex-col gap-4 rounded-lg border bg-card p-4 shadow-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h2 className="truncate font-semibold">{guest.name}</h2>
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                        {guest.vmid}
                      </span>
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {hostNames.get(guest.hostId) ?? guest.hostId} ·{' '}
                      {guest.type.toUpperCase()}
                    </p>
                  </div>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-xs font-medium capitalize ${statusClass(guest.status)}`}
                  >
                    {guest.status}
                  </span>
                </div>

                <dl className="grid grid-cols-3 gap-2 text-xs">
                  <ResourceMetric
                    icon={Cpu}
                    label="CPU"
                    value={guest.maxcpu?.toString() ?? '—'}
                  />
                  <ResourceMetric
                    icon={MemoryStick}
                    label="Memory"
                    value={formatBytes(guest.maxmem)}
                  />
                  <ResourceMetric
                    icon={HardDrive}
                    label="Config"
                    value={
                      guest.configuration.status === 'configured'
                        ? 'YAML'
                        : guest.configuration.status === 'ignored'
                          ? 'Ignored'
                          : 'Orphan'
                    }
                    warning={guest.configuration.status === 'orphan'}
                  />
                </dl>

                <Link
                  className="mt-auto inline-flex h-9 items-center justify-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90"
                  to={`/resources/${encodeURIComponent(guest.hostId)}/${guest.vmid}?type=${guest.type}`}
                >
                  View guest
                </Link>
              </article>
            ))}
          </div>
          {pageCount > 1 && (
            <div className="flex items-center justify-between gap-3">
              <Button
                variant="outline"
                size="sm"
                disabled={visiblePage === 1}
                onClick={() => setPage((current) => current - 1)}
              >
                Previous
              </Button>
              <span className="text-sm text-muted-foreground">
                Page {visiblePage} of {pageCount}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={visiblePage === pageCount}
                onClick={() => setPage((current) => current + 1)}
              >
                Next
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly {
    readonly value: string;
    readonly label: string;
  }[];
}) {
  return (
    <label className="grid gap-1 text-xs font-medium text-muted-foreground">
      {label}
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 rounded-md border border-border bg-background px-3 text-sm text-foreground"
      >
        <option value="">All</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ResourceMetric({
  icon: Icon,
  label,
  value,
  warning = false,
}: {
  readonly icon: typeof Cpu;
  readonly label: string;
  readonly value: string;
  readonly warning?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-md bg-muted p-2">
      <dt className="flex items-center gap-1 text-muted-foreground">
        <Icon aria-hidden className="h-3.5 w-3.5" />
        {label}
      </dt>
      <dd
        className={`mt-1 truncate font-medium ${warning ? 'text-amber-600 dark:text-amber-400' : ''}`}
      >
        {value}
      </dd>
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  Clock3,
  Cpu,
  FileCode2,
  MemoryStick,
  ShieldAlert,
} from 'lucide-react';
import { apiClient } from '../api/client';
import type { paths } from '../api/schema';
import { Button } from '../components/ui/button';
import { GuestPowerActions } from '../components/guest-power-actions';
import { YamlCodeViewer } from '../components/yaml-code-viewer';
import {
  GuestYamlEditor,
  type GuestYamlSnapshot,
} from '../components/guest-yaml-editor';
import { useAuth } from '../auth/auth-context';
import { useJobEvents } from '../hooks/use-job-events';

type GuestDetail =
  paths['/api/inventory/guests/{hostId}/{vmid}']['get']['responses']['200']['content']['application/json'];

const TERMINAL_JOB_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

export function isTerminalJobEvent(event: unknown): boolean {
  if (typeof event !== 'object' || event === null) return false;
  const status = (event as { status?: unknown }).status;
  return typeof status === 'string' && TERMINAL_JOB_STATUSES.has(status);
}

export function formatGuestBytes(value: number | undefined): string {
  if (value === undefined) return 'Not reported';
  return `${(value / 1024 ** 2).toFixed(0)} MB`;
}

export function formatGuestUptime(value: number | undefined): string {
  if (value === undefined) return 'Not reported';
  const days = Math.floor(value / 86_400);
  const hours = Math.floor((value % 86_400) / 3_600);
  return days > 0 ? `${days}d ${hours}h` : `${hours}h`;
}

export function formatGuestConfigValue(value: unknown): string {
  if (value === undefined) return 'Not set';
  if (Array.isArray(value)) return `${value.length} configured`;
  if (typeof value === 'object' && value !== null) {
    const tagged = value as { tag?: unknown; value?: unknown };
    if (typeof tagged.tag === 'string') {
      return `!${tagged.tag} ${String(tagged.value ?? '')}`.trim();
    }
    return JSON.stringify(value);
  }
  return String(value);
}

export function GuestDetailPage() {
  const { hostId = '', vmid: vmidParam = '' } = useParams();
  const [searchParams] = useSearchParams();
  const [detail, setDetail] = useState<GuestDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [trackedJobId, setTrackedJobId] = useState<string | null>(null);
  const [jobFeedback, setJobFeedback] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importFeedback, setImportFeedback] = useState<string | null>(null);
  const { user } = useAuth();
  const vmid = Number(vmidParam);
  const type = searchParams.get('type');

  const loadDetail = useCallback(
    async (quiet = false) => {
      if (!hostId || !Number.isInteger(vmid)) {
        setError('Invalid guest route.');
        setLoading(false);
        return;
      }

      if (!quiet) setLoading(true);
      setError(null);
      try {
        const result = await apiClient.GET(
          '/api/inventory/guests/{hostId}/{vmid}',
          {
            params: {
              path: { hostId, vmid },
              query: type === 'lxc' || type === 'vm' ? { type } : {},
            },
          },
        );
        if (result.error || !result.data) {
          setError('Guest not found or access denied.');
          return;
        }
        setDetail(result.data);
      } catch (loadError) {
        setError(
          loadError instanceof Error ? loadError.message : String(loadError),
        );
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [hostId, type, vmid],
  );

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  useJobEvents(trackedJobId, {
    onJob: (event: unknown) => {
      if (!isTerminalJobEvent(event)) return;
      setTrackedJobId(null);
      setJobFeedback(
        'Queued job finished. Live state refreshed from the host.',
      );
      void loadDetail(true);
    },
  });

  const importOrphan = async () => {
    if (!detail) return;
    setImporting(true);
    setImportError(null);
    setImportFeedback(null);
    try {
      const plan = await apiClient.POST('/api/plans/guest-import', {
        body: { hostId: detail.summary.hostId, vmid: detail.summary.vmid },
      });
      if (plan.error || !plan.data) {
        setImportError('Unable to create the import plan.');
        return;
      }
      const applied = await apiClient.POST('/api/plans/{planId}/apply', {
        params: { path: { planId: plan.data.id } },
        body: {},
      });
      if (applied.error || !applied.data) {
        setImportError('Unable to queue the import job.');
        return;
      }
      setImportFeedback(
        `Import queued as job ${applied.data.job.id}. The page refreshes when it finishes.`,
      );
      setTrackedJobId(applied.data.job.id);
    } catch {
      setImportError('Unable to import this guest.');
    } finally {
      setImporting(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4" aria-label="Loading guest">
        <div className="h-8 w-64 animate-pulse rounded bg-muted" />
        <div className="grid gap-3 md:grid-cols-3">
          {[1, 2, 3].map((item) => (
            <div
              key={item}
              className="h-28 animate-pulse rounded-lg border bg-muted"
            />
          ))}
        </div>
      </div>
    );
  }

  if (!detail || error) {
    return (
      <div className="space-y-4">
        <Link
          to="/resources"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft aria-hidden className="h-4 w-4" />
          Back to Resources
        </Link>
        <div
          role="alert"
          className="rounded-md border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-600 dark:text-rose-400"
        >
          {error ?? 'Guest not found.'}
        </div>
      </div>
    );
  }

  const configured = detail.configuration;
  const configuredConfig =
    configured.status === 'configured' ? configured.config : undefined;
  const comparisons = [
    ['CPU cores', detail.canonicalConfig.cpu, configuredConfig?.cpu],
    ['Memory', detail.canonicalConfig.ram, configuredConfig?.ram],
    ['Disks', detail.canonicalConfig.disks, configuredConfig?.disks],
    ['Networks', detail.canonicalConfig.network, configuredConfig?.network],
    [
      'Protection',
      detail.canonicalConfig.protection,
      configuredConfig?.protection,
    ],
  ] as const;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          to="/resources"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft aria-hidden className="h-4 w-4" />
          Back to Resources
        </Link>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-bold tracking-tight">
                {detail.summary.name}
              </h1>
              <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground">
                VMID {detail.summary.vmid}
              </span>
              <span className="rounded bg-muted px-2 py-0.5 text-xs font-medium uppercase text-muted-foreground">
                {detail.summary.type}
              </span>
            </div>
            <p className="text-sm text-muted-foreground">
              {detail.summary.hostId} · live config via{' '}
              {detail.source.toUpperCase()}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled
              title="Plan/apply arrives in M6"
            >
              Plan changes
            </Button>
          </div>
        </div>
      </div>

      <GuestPowerActions
        hostId={detail.summary.hostId}
        vmid={detail.summary.vmid}
        name={detail.summary.name}
        status={detail.summary.status}
        role={user?.role ?? 'viewer'}
        onJobQueued={(jobId) => {
          setTrackedJobId(jobId);
          setJobFeedback(`Waiting for job ${jobId} to finish…`);
        }}
      />

      {jobFeedback && (
        <div
          role="status"
          className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground"
        >
          {jobFeedback}
        </div>
      )}

      {configured.status === 'orphan' && (
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-4"
        >
          <div className="flex gap-3">
            <ShieldAlert
              aria-hidden
              className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400"
            />
            <div className="min-w-0">
              <h2 className="font-semibold">Unmanaged guest (orphan)</h2>
              <p className="text-sm text-muted-foreground">
                This live guest has no deployment YAML. Import it to create a
                deployment file from the current Proxmox configuration.
              </p>
            </div>
          </div>
          <div>
            <Button
              size="sm"
              disabled={importing || user?.role === 'viewer'}
              title={
                user?.role === 'viewer'
                  ? 'Viewers have read-only access'
                  : 'Create deployment YAML from this live guest'
              }
              onClick={() => void importOrphan()}
            >
              <FileCode2 aria-hidden className="h-4 w-4" />
              {importing ? 'Importing…' : 'Import to YAML'}
            </Button>
          </div>
          {importError && (
            <p
              role="alert"
              className="rounded-md border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-700 dark:text-rose-300"
            >
              {importError}
            </p>
          )}
          {importFeedback && (
            <p
              role="status"
              className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300"
            >
              {importFeedback}
            </p>
          )}
        </div>
      )}

      <section className="grid gap-3 md:grid-cols-3" aria-label="Live summary">
        <SummaryCard
          icon={Cpu}
          label="CPU"
          value={
            detail.summary.maxcpu === undefined
              ? 'Not reported'
              : `${detail.summary.maxcpu} cores`
          }
          detail={`${Math.round((detail.summary.cpu ?? 0) * 100)}% current usage`}
        />
        <SummaryCard
          icon={MemoryStick}
          label="Memory"
          value={formatGuestBytes(detail.summary.maxmem)}
          detail={`${formatGuestBytes(detail.summary.mem)} in use`}
        />
        <SummaryCard
          icon={Clock3}
          label="Status"
          value={detail.summary.status}
          detail={`Uptime ${formatGuestUptime(detail.summary.uptime)}`}
        />
      </section>

      <section className="overflow-hidden rounded-lg border bg-card">
        <div className="border-b p-4">
          <h2 className="font-semibold">Live vs configured</h2>
          <p className="text-sm text-muted-foreground">
            A read-only summary. Drift actions arrive with plan/apply.
          </p>
        </div>
        <div className="divide-y divide-border md:hidden">
          {comparisons.map(([label, liveValue, configuredValue]) => (
            <dl key={label} className="grid grid-cols-2 gap-3 p-4 text-sm">
              <dt className="col-span-2 font-medium">{label}</dt>
              <div className="min-w-0">
                <dt className="text-[0.7rem] font-medium text-muted-foreground uppercase">
                  Live
                </dt>
                <dd className="mt-1 break-words font-mono text-xs">
                  {formatGuestConfigValue(liveValue)}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-[0.7rem] font-medium text-muted-foreground uppercase">
                  Configured YAML
                </dt>
                <dd className="mt-1 break-words font-mono text-xs">
                  {configured.status === 'configured'
                    ? formatGuestConfigValue(configuredValue)
                    : 'No YAML'}
                </dd>
              </div>
            </dl>
          ))}
        </div>
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full min-w-[34rem] text-left text-sm">
            <thead className="bg-muted/60 text-xs text-muted-foreground uppercase">
              <tr>
                <th className="px-4 py-3">Field</th>
                <th className="px-4 py-3">Live</th>
                <th className="px-4 py-3">Configured YAML</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {comparisons.map(([label, liveValue, configuredValue]) => (
                <tr key={label}>
                  <th className="px-4 py-3 font-medium">{label}</th>
                  <td className="px-4 py-3 font-mono text-xs">
                    {formatGuestConfigValue(liveValue)}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {configured.status === 'configured'
                      ? formatGuestConfigValue(configuredValue)
                      : 'No YAML'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {configured.status === 'configured' && editing ? (
        <GuestYamlEditor
          hostId={detail.summary.hostId}
          vmid={detail.summary.vmid}
          guestName={detail.summary.name}
          role={user?.role ?? 'viewer'}
          snapshot={{
            relativePath: configured.relativePath,
            rawYaml: configured.rawYaml,
            hash: configured.hash,
            ...(configured.config ? { config: configured.config } : {}),
            issues: configured.issues,
          }}
          onCancel={() => setEditing(false)}
          onSaved={(snapshot: GuestYamlSnapshot) => {
            setDetail({
              ...detail,
              configuration: {
                status: 'configured',
                relativePath: snapshot.relativePath,
                rawYaml: snapshot.rawYaml,
                hash: snapshot.hash,
                ...(snapshot.config ? { config: snapshot.config } : {}),
                issues: [...snapshot.issues],
              },
            });
          }}
        />
      ) : configured.status === 'configured' ? (
        <section className="space-y-3 rounded-lg border bg-card p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <FileCode2 aria-hidden className="h-5 w-5" />
                <h2 className="font-semibold">Deployment YAML</h2>
              </div>
              <p className="break-all font-mono text-xs text-muted-foreground">
                {configured.relativePath}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={user?.role === 'viewer'}
              title={
                user?.role === 'viewer'
                  ? 'Viewers have read-only access'
                  : 'Edit deployment YAML'
              }
              onClick={() => setEditing(true)}
            >
              Edit YAML
            </Button>
          </div>
          {configured.issues.length > 0 && (
            <div
              role="alert"
              className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm"
            >
              <div className="flex items-center gap-2 font-medium">
                <AlertTriangle aria-hidden className="h-4 w-4" />
                YAML validation issues
              </div>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
                {configured.issues.map((issue) => (
                  <li key={`${issue.path}:${issue.code}`}>
                    {issue.path || 'document'}: {issue.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <YamlCodeViewer
            value={configured.rawYaml}
            label={`${detail.summary.name} deployment YAML`}
          />
        </section>
      ) : null}

      <section className="space-y-3 rounded-lg border bg-card p-4">
        <div>
          <h2 className="font-semibold">Live Proxmox configuration</h2>
          <p className="text-sm text-muted-foreground">
            Raw{' '}
            <code>
              {detail.summary.type === 'lxc' ? 'pct config' : 'qm config'}
            </code>{' '}
            output returned by the {detail.source.toUpperCase()} channel. This
            is Proxmox&apos;s native key-value format, not the HAC Manager{' '}
            <code>deployment.yaml</code> format.
          </p>
        </div>
        <pre className="max-h-80 overflow-auto rounded-md bg-muted p-4 font-mono text-xs whitespace-pre-wrap">
          {detail.rawConfig || 'No raw configuration returned.'}
        </pre>
      </section>
    </div>
  );
}

function SummaryCard({
  icon: Icon,
  label,
  value,
  detail,
}: {
  readonly icon: typeof Cpu;
  readonly label: string;
  readonly value: string;
  readonly detail: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase">
        <Icon aria-hidden className="h-4 w-4" />
        {label}
      </div>
      <p className="mt-2 text-xl font-semibold capitalize">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Server,
  Terminal,
  HardDrive,
  Wrench,
  RefreshCw,
  ExternalLink,
  ShieldAlert,
} from 'lucide-react';
import type { paths } from '../api/schema';
import { apiClient } from '../api/client';
import { Button } from '../components/ui/button';

export interface HostDetailData {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly index: number;
  readonly status: string;
  readonly runtime: {
    readonly overall: string;
    readonly ssh: {
      readonly status: string;
      readonly error?: string;
      readonly lastCheckedAt?: string;
    };
    readonly api: {
      readonly configured: boolean;
      readonly status: string;
      readonly error?: string;
      readonly lastCheckedAt?: string;
    };
    readonly vault: { readonly status: string };
    readonly queue: { readonly status: string; readonly activeJobId?: string };
    readonly lastSeenAt?: string;
    readonly issues: readonly string[];
  };
  readonly connection: {
    readonly ssh: {
      readonly host: string;
      readonly port: number;
      readonly username: string;
      readonly fingerprint?: string;
      readonly authMethod: string;
    };
    readonly api?: {
      readonly configured: boolean;
      readonly url?: string;
      readonly tokenId?: string;
      readonly fingerprint?: string;
    };
  };
  readonly ignoredGuestsCount?: number;
  readonly defaults?: {
    readonly deployment?: string;
    readonly filemappings?: string;
  };
}

export interface ProbeResult {
  readonly hostId: string;
  readonly pveVersion: string;
  readonly isCluster: boolean;
  readonly clusterName?: string;
  readonly storages: readonly {
    readonly name: string;
    readonly type: string;
    readonly content: readonly string[];
    readonly total?: number;
    readonly used?: number;
    readonly avail?: number;
    readonly shared: boolean;
  }[];
  readonly tools: Record<string, boolean>;
  readonly warnings: readonly string[];
  readonly probedAt: string;
}

export type TestResultData =
  paths['/api/hosts/{id}/test-connection']['post']['responses']['200']['content']['application/json'];

export function HostDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [host, setHost] = useState<HostDetailData | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [probeLoading, setProbeLoading] = useState(true);
  const [probing, setProbing] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [testResult, setTestResult] = useState<TestResultData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const fetchHostDetail = useCallback(
    async (quiet = false) => {
      if (!id) {
        setError('Host not found.');
        setLoading(false);
        return;
      }
      if (!quiet) setLoading(true);
      setError(null);
      try {
        const { data, error: apiErr } = await apiClient.GET('/api/hosts/{id}', {
          params: { path: { id } },
        });

        if (apiErr || !data) {
          setError('Host not found or access denied.');
          return;
        }

        setHost(data.host as HostDetailData);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [id],
  );

  const loadProbe = useCallback(async () => {
    if (!id) {
      setProbeLoading(false);
      return;
    }
    setProbeLoading(true);
    try {
      const probeRes = await apiClient.GET('/api/hosts/{id}/probe', {
        params: { path: { id } },
      });
      if (probeRes.data) {
        setProbe(probeRes.data as unknown as ProbeResult);
      }
    } catch {
      // Probe data is optional; keep the rest of the page usable.
    } finally {
      setProbeLoading(false);
    }
  }, [id]);

  useEffect(() => {
    // Render the host detail immediately. Capability probing can take a
    // while over SSH, so it loads in the background and never blocks the page.
    void fetchHostDetail();
    void loadProbe();
  }, [fetchHostDetail, loadProbe]);

  const handleTestConnection = async () => {
    if (!id) return;
    setTestingConnection(true);
    setActionError(null);
    try {
      const { data, error: apiError } = await apiClient.POST(
        '/api/hosts/{id}/test-connection',
        {
          params: { path: { id } },
        },
      );
      if (apiError || !data) {
        setActionError('Unable to test the host connection.');
      } else {
        setTestResult(data);
        // The backend persists the channel status. Refresh the detail quietly
        // so the saved runtime block reflects the result immediately.
        void fetchHostDetail(true);
      }
    } catch {
      setActionError('Unable to test the host connection.');
    } finally {
      setTestingConnection(false);
    }
  };

  const handleRunProbe = async () => {
    if (!id) return;
    setProbing(true);
    setActionError(null);
    try {
      const { data, error: apiError } = await apiClient.POST(
        '/api/hosts/{id}/probe',
        {
          params: { path: { id } },
        },
      );
      if (apiError || !data) {
        setActionError('Unable to probe host capabilities.');
      } else {
        setProbe(data as unknown as ProbeResult);
      }
    } catch {
      setActionError('Unable to probe host capabilities.');
    } finally {
      setProbing(false);
    }
  };

  const formatBytes = (bytes?: number) => {
    if (bytes === undefined || bytes === null || Number.isNaN(bytes))
      return 'N/A';
    const gb = bytes / (1024 * 1024 * 1024);
    if (gb < 1000) return `${gb.toFixed(1)} GB`;
    return `${(gb / 1024).toFixed(1)} TB`;
  };

  if (loading) {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="h-8 w-48 bg-muted rounded" />
        <div className="h-64 bg-card rounded-lg border" />
      </div>
    );
  }

  if (error || !host) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={() => navigate('/')}>
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Hosts
        </Button>
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          {error ?? 'Host not found'}
        </div>
      </div>
    );
  }

  const lastCheckedAt =
    host.runtime.ssh.lastCheckedAt ?? host.runtime.api.lastCheckedAt;

  return (
    <div className="space-y-6">
      {/* Back Button & Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="space-y-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate('/')}
            className="pl-0 text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="w-4 h-4 mr-1.5" />
            Back to Hosts
          </Button>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight">{host.name}</h1>
            <span className="text-xs font-mono bg-muted text-muted-foreground px-2 py-0.5 rounded">
              index: {host.index}
            </span>
          </div>
          <p className="text-xs font-mono text-muted-foreground">{host.id}</p>
        </div>

        <div className="flex flex-col items-start gap-2 sm:items-end">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={testingConnection}
              onClick={handleTestConnection}
              title="Check SSH and Proxmox API connectivity now and save the result."
              className="flex items-center gap-1.5"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${testingConnection ? 'animate-spin' : ''}`}
              />
              {testingConnection ? 'Testing...' : 'Test Connection'}
            </Button>

            <Button
              size="sm"
              disabled={probing}
              onClick={handleRunProbe}
              title="Probe host capabilities: PVE version, installed tools, storage pools, and cluster membership."
              className="flex items-center gap-1.5"
            >
              <Wrench
                className={`w-3.5 h-3.5 ${probing ? 'animate-spin' : ''}`}
              />
              {probing ? 'Probing...' : 'Run Probe'}
            </Button>
          </div>
          <p className="max-w-sm text-xs text-muted-foreground sm:text-right">
            Run Probe refreshes host capabilities (PVE version, tools, storage
            pools, cluster warnings). Results are cached for this server
            process, and this page loads them automatically.
          </p>
        </div>
      </div>

      {actionError && (
        <p
          role="alert"
          className="rounded-md border border-destructive/50 p-3 text-sm text-destructive"
        >
          {actionError}
        </p>
      )}

      {/* Connection Test Result Banner */}
      {testResult && (
        <div className="rounded-lg border bg-card p-4 space-y-2 text-xs font-mono">
          <div className="flex items-center justify-between border-b pb-2">
            <span className="font-semibold text-sm">
              Connection Test Results
            </span>
            <span
              className={`font-bold uppercase ${
                testResult.ok ? 'text-emerald-500' : 'text-rose-500'
              }`}
            >
              {testResult.ok ? 'OK' : 'FAILED'}
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
            <div className="space-y-1">
              <span className="text-muted-foreground">SSH Channel:</span>
              <div className="font-medium">
                {testResult.ssh?.ok ? (
                  <span className="text-emerald-500">
                    Connected ({testResult.ssh.latencyMs ?? 0}ms)
                    {host.connection.ssh.fingerprint && (
                      <span className="block text-[11px] text-muted-foreground truncate">
                        Key: {host.connection.ssh.fingerprint}
                      </span>
                    )}
                  </span>
                ) : (
                  <span className="text-rose-500">
                    {testResult.ssh?.error ?? 'Failed'}
                  </span>
                )}
              </div>
            </div>

            <div className="space-y-1">
              <span className="text-muted-foreground">API Channel:</span>
              <div className="font-medium">
                {testResult.api?.ok ? (
                  <span className="text-emerald-500">
                    Connected ({testResult.api.latencyMs ?? 0}ms)
                    {host.connection.api?.fingerprint && (
                      <span className="block text-[11px] text-muted-foreground truncate">
                        TLS: {host.connection.api.fingerprint}
                      </span>
                    )}
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    {testResult.api?.error ?? 'Not configured / Failed'}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Cluster Warning Banner (D-25 / D-26) */}
      {probe?.isCluster && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-amber-500 space-y-2">
          <div className="flex items-center gap-2 font-semibold text-sm">
            <ShieldAlert className="w-5 h-5 flex-shrink-0" />
            <span>
              Cluster Membership Detected (
              {probe.clusterName || 'Proxmox Cluster'})
            </span>
          </div>
          <p className="text-xs text-amber-500/90 leading-relaxed">
            HAC Manager v1 manages standalone Proxmox VE hosts. Cluster-aware
            management is planned for a later release.
          </p>
        </div>
      )}

      {/* Main Grid: Channels, Defaults, Live Links */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Channel Configuration */}
        <div className="rounded-lg border bg-card text-card-foreground p-5 space-y-4">
          <div className="flex items-center gap-2 border-b pb-3">
            <Terminal className="w-4 h-4 text-primary" />
            <h2 className="font-semibold text-base">Channel Configuration</h2>
          </div>

          {/* Last known channel status, persisted by the backend */}
          <div className="rounded-md border bg-muted/30 p-3 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">Saved runtime status</span>
              <span className="font-mono uppercase text-muted-foreground">
                {host.runtime.overall}
              </span>
            </div>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">SSH</span>
                <span
                  className={
                    host.runtime.ssh.status === 'connected'
                      ? 'font-medium text-emerald-600 dark:text-emerald-400'
                      : 'font-medium text-rose-600 dark:text-rose-400'
                  }
                >
                  {host.runtime.ssh.status}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">API</span>
                <span
                  className={
                    host.runtime.api.status === 'connected'
                      ? 'font-medium text-emerald-600 dark:text-emerald-400'
                      : 'font-medium text-rose-600 dark:text-rose-400'
                  }
                >
                  {host.runtime.api.configured
                    ? host.runtime.api.status
                    : 'not configured'}
                </span>
              </div>
            </div>
            <p className="mt-2 text-muted-foreground">
              {lastCheckedAt
                ? `Last checked ${new Date(lastCheckedAt).toLocaleString()}`
                : 'Not checked yet — run Test Connection once, then this survives restarts.'}
            </p>
            {host.runtime.ssh.error && (
              <p className="mt-1 text-rose-600 dark:text-rose-400">
                SSH: {host.runtime.ssh.error}
              </p>
            )}
            {host.runtime.api.error && (
              <p className="mt-1 text-rose-600 dark:text-rose-400">
                API: {host.runtime.api.error}
              </p>
            )}
          </div>

          <div className="space-y-4 text-sm">
            {/* SSH */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="font-medium text-xs text-muted-foreground uppercase tracking-wider">
                  SSH Channel
                </span>
                <span className="text-xs px-2 py-0.5 rounded bg-muted font-mono">
                  {host.connection.ssh.authMethod} auth
                </span>
              </div>
              <div className="bg-muted/50 p-3 rounded-md text-xs font-mono space-y-1">
                <div>
                  Host: {host.connection.ssh.host}:{host.connection.ssh.port}
                </div>
                <div>User: {host.connection.ssh.username}</div>
                {host.connection.ssh.fingerprint && (
                  <div className="truncate text-muted-foreground">
                    Fingerprint: {host.connection.ssh.fingerprint}
                  </div>
                )}
              </div>
            </div>

            {/* Proxmox REST API */}
            <div className="space-y-1.5 pt-2">
              <div className="flex items-center justify-between">
                <span className="font-medium text-xs text-muted-foreground uppercase tracking-wider">
                  Proxmox REST API Channel
                </span>
                <span className="text-xs px-2 py-0.5 rounded bg-muted">
                  {host.connection.api?.configured
                    ? 'Configured'
                    : 'Not configured'}
                </span>
              </div>
              {host.connection.api?.configured ? (
                <div className="bg-muted/50 p-3 rounded-md text-xs font-mono space-y-1">
                  <div>URL: {host.connection.api.url}</div>
                  <div>Token ID: {host.connection.api.tokenId}</div>
                  {host.connection.api.fingerprint && (
                    <div className="truncate text-muted-foreground">
                      TLS Fingerprint: {host.connection.api.fingerprint}
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground italic">
                  Proxmox API credentials are optional. If omitted, HAC Manager
                  uses SSH execution fallback.
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Defaults & Resources Shortcut */}
        <div className="rounded-lg border bg-card text-card-foreground p-5 space-y-4">
          <div className="flex items-center gap-2 border-b pb-3">
            <Server className="w-4 h-4 text-primary" />
            <h2 className="font-semibold text-base">
              Host Defaults & Resources
            </h2>
          </div>

          <div className="space-y-4 text-sm">
            <div className="space-y-2">
              <span className="font-medium text-xs text-muted-foreground uppercase tracking-wider">
                Configured Defaults
              </span>
              <div className="bg-muted/50 p-3 rounded-md text-xs font-mono space-y-1">
                <div>
                  Deployment:{' '}
                  {host.defaults?.deployment ??
                    'hosts/<id>/default-deployment.yaml'}
                </div>
                <div>
                  Filemappings:{' '}
                  {host.defaults?.filemappings ??
                    'hosts/<id>/default-filemappings.yaml'}
                </div>
                <div>
                  Ignored Guests: {host.ignoredGuestsCount ?? 0} defined in
                  host.yaml
                </div>
              </div>
            </div>

            <div className="pt-4 border-t space-y-2">
              <span className="font-medium text-xs text-muted-foreground uppercase tracking-wider">
                Live Guest Inventory
              </span>
              <p className="text-xs text-muted-foreground">
                View containers and virtual machines currently running on this
                Proxmox host.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate(`/resources?hostId=${host.id}`)}
                className="w-full flex items-center justify-center gap-2 text-xs"
              >
                <span>View Guests on {host.name}</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Capability Probe Details (Storages & Tools) */}
      {probeLoading && !probe && (
        <div className="flex items-center gap-2 rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          <RefreshCw className="h-4 w-4 animate-spin" aria-hidden />
          Checking host capabilities (PVE version, tools, storage pools)…
        </div>
      )}
      {probe && (
        <div className="rounded-lg border bg-card text-card-foreground p-5 space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b pb-3">
            <div className="flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-primary" />
              <h2 className="font-semibold text-base">
                Host Capabilities & Storage Pools
              </h2>
            </div>
            <div className="text-xs font-mono text-muted-foreground">
              PVE: {probe.pveVersion}
            </div>
          </div>

          {/* Tools Grid */}
          <div className="space-y-2">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Installed Hypervisor Tools
            </span>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {Object.entries(probe.tools).map(([tool, available]) => (
                <div
                  key={tool}
                  className={`flex items-center justify-between p-2 rounded-md border text-xs font-mono ${
                    available
                      ? 'bg-muted/40 border-border'
                      : 'bg-destructive/5 border-destructive/20 text-muted-foreground'
                  }`}
                >
                  <span>{tool}</span>
                  {available ? (
                    <span className="text-emerald-500 font-semibold">
                      Available
                    </span>
                  ) : (
                    <span className="text-muted-foreground">Missing</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Storages Table */}
          <div className="space-y-2 pt-2">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Storage Pools ({probe.storages.length})
            </span>
            <div className="border rounded-md overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-muted/50 border-b text-muted-foreground">
                  <tr>
                    <th className="p-2.5 font-medium">Storage</th>
                    <th className="p-2.5 font-medium">Type</th>
                    <th className="p-2.5 font-medium">Content</th>
                    <th className="p-2.5 font-medium">Available</th>
                    <th className="p-2.5 font-medium">Total</th>
                    <th className="p-2.5 font-medium">Shared</th>
                  </tr>
                </thead>
                <tbody className="divide-y font-mono">
                  {probe.storages.map((s) => (
                    <tr key={s.name} className="hover:bg-muted/30">
                      <td className="p-2.5 font-semibold text-foreground">
                        {s.name}
                      </td>
                      <td className="p-2.5 text-muted-foreground">{s.type}</td>
                      <td className="p-2.5 text-muted-foreground max-w-xs truncate">
                        {s.content.join(', ')}
                      </td>
                      <td className="p-2.5">{formatBytes(s.avail)}</td>
                      <td className="p-2.5">{formatBytes(s.total)}</td>
                      <td className="p-2.5">
                        {s.shared ? (
                          <span className="text-emerald-500 font-semibold">
                            Yes
                          </span>
                        ) : (
                          <span className="text-muted-foreground">No</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

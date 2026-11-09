import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Server,
  RefreshCw,
  Plus,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  HelpCircle,
  ShieldCheck,
  Activity,
  Layers,
  Copy,
  Check,
  ArrowRight,
} from 'lucide-react';
import { apiClient } from '../api/client';
import type { paths } from '../api/schema';
import { Button } from '../components/ui/button';

export interface ChannelStatus {
  readonly status: string;
  readonly error?: string;
  readonly lastCheckedAt?: string;
  readonly configured?: boolean;
}

export type ConnectionTestResult =
  paths['/api/hosts/{id}/test-connection']['post']['responses']['200']['content']['application/json'];

export interface HostSummary {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly index: number;
  readonly status:
    'unknown' | 'healthy' | 'degraded' | 'unreachable' | 'error' | string;
  readonly runtime: {
    readonly overall: string;
    readonly ssh: ChannelStatus;
    readonly api: ChannelStatus & { readonly configured: boolean };
    readonly vault: { readonly status: string; readonly error?: string };
    readonly queue: { readonly status: string; readonly activeJobId?: string };
    readonly issues: readonly string[];
  };
  readonly updatedAt: string;
  guestCount?: number;
}

export interface ConnectionTestState {
  readonly testing: boolean;
  readonly result?: ConnectionTestResult | undefined;
}

export function HostsPage() {
  const navigate = useNavigate();
  const [hosts, setHosts] = useState<readonly HostSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resyncing, setResyncing] = useState(false);
  const [showAddGuidance, setShowAddGuidance] = useState(false);
  const [copiedYaml, setCopiedYaml] = useState(false);
  const [testStates, setTestStates] = useState<
    Record<string, ConnectionTestState>
  >({});

  const fetchHosts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [hostsRes, invRes] = await Promise.all([
        apiClient.GET('/api/hosts'),
        apiClient.GET('/api/inventory/hosts'),
      ]);

      if (hostsRes.error || !hostsRes.data) {
        setError('Failed to load host registry.');
        return;
      }

      const guestCountMap = new Map<string, number>();
      if (invRes.data?.hosts) {
        for (const h of invRes.data.hosts) {
          guestCountMap.set(h.hostId, h.guestCount);
        }
      }

      const enriched = hostsRes.data.hosts.map((h) => ({
        ...h,
        guestCount: guestCountMap.get(h.id) ?? 0,
      }));

      setHosts(enriched);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchHosts();
  }, [fetchHosts]);

  const handleResync = async () => {
    setResyncing(true);
    try {
      const result = await apiClient.POST('/api/hosts/sync');
      if (result.error) {
        setError('Failed to resync host registry.');
        return;
      }
      await fetchHosts();
    } catch {
      setError('Failed to resync host registry.');
    } finally {
      setResyncing(false);
    }
  };

  const handleTestConnection = async (hostId: string) => {
    setTestStates((prev) => ({
      ...prev,
      [hostId]: { testing: true },
    }));

    try {
      const { data, error: apiErr } = await apiClient.POST(
        '/api/hosts/{id}/test-connection',
        {
          params: {
            path: { id: hostId },
          },
        },
      );

      if (apiErr || !data) {
        setTestStates((prev) => ({
          ...prev,
          [hostId]: {
            testing: false,
            result: {
              ok: false,
              ssh: { ok: false, status: 'error', error: 'Request failed' },
              api: { ok: false, status: 'error', error: 'Request failed' },
            },
          },
        }));
        return;
      }

      setTestStates((prev) => ({
        ...prev,
        [hostId]: {
          testing: false,
          result: data,
        },
      }));
    } catch (err) {
      setTestStates((prev) => ({
        ...prev,
        [hostId]: {
          testing: false,
          result: {
            ok: false,
            ssh: { ok: false, status: 'error', error: String(err) },
            api: { ok: false, status: 'error', error: String(err) },
          },
        },
      }));
    }
  };

  const sampleHostYaml = `schema_version: 1
id: pve-02
name: Proxmox Host 2
type: proxmox
index: 2
connection:
  ssh:
    host: 192.0.2.52
    port: 22
    username: root
  api:
    url: https://192.0.2.52:8006
    token_id: root@pam!hacm
    token_secret: !secret pve02_token_secret`;

  const copyYamlToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(sampleHostYaml);
      setCopiedYaml(true);
      setTimeout(() => setCopiedYaml(false), 2000);
    } catch {
      setError('Could not copy YAML to the clipboard.');
    }
  };

  const renderStatusBadge = (status: string) => {
    switch (status) {
      case 'healthy':
      case 'online':
      case 'connected':
      case 'ok':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">
            <CheckCircle2 className="w-3.5 h-3.5" />
            Healthy
          </span>
        );
      case 'degraded':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-500/10 text-amber-500 border border-amber-500/20">
            <AlertTriangle className="w-3.5 h-3.5" />
            Degraded
          </span>
        );
      case 'unreachable':
      case 'error':
      case 'failed':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-rose-500/10 text-rose-500 border border-rose-500/20">
            <XCircle className="w-3.5 h-3.5" />
            Error
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-muted text-muted-foreground border border-border">
            <HelpCircle className="w-3.5 h-3.5" />
            {status || 'Unknown'}
          </span>
        );
    }
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Hosts</h1>
          <p className="text-sm text-muted-foreground">
            Proxmox VE hypervisors registered from data directory YAML files.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleResync}
            disabled={resyncing || loading}
            className="flex items-center gap-2"
          >
            <RefreshCw
              className={`w-4 h-4 ${resyncing ? 'animate-spin' : ''}`}
            />
            Resync YAML
          </Button>
          <Button
            size="sm"
            onClick={() => setShowAddGuidance((prev) => !prev)}
            className="flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            Add Host
          </Button>
        </div>
      </div>

      {/* Add Host Guidance Panel */}
      {showAddGuidance && (
        <div className="rounded-lg border bg-card p-5 text-card-foreground shadow-sm space-y-4">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-2">
              <Server className="w-5 h-5 text-primary" />
              <h2 className="text-base font-semibold">How to Add a Host</h2>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowAddGuidance(false)}
            >
              Close
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            HAC Manager manages infrastructure declaratively from files. To add
            a host, create a new directory{' '}
            <code className="bg-muted px-1.5 py-0.5 rounded text-xs font-mono">
              hosts/&lt;host-id&gt;/host.yaml
            </code>{' '}
            in your data directory:
          </p>
          <div className="relative">
            <pre className="bg-muted p-4 rounded-md text-xs font-mono overflow-x-auto text-foreground">
              {sampleHostYaml}
            </pre>
            <Button
              variant="outline"
              size="sm"
              onClick={copyYamlToClipboard}
              className="absolute top-2 right-2 flex items-center gap-1.5 text-xs"
            >
              {copiedYaml ? (
                <Check className="w-3.5 h-3.5" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
              {copiedYaml ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Once saved, click <strong>Resync YAML</strong> above to discover the
            new host immediately.
          </p>
        </div>
      )}

      {/* Error Banner */}
      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Loading Skeleton */}
      {loading && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((n) => (
            <div
              key={n}
              className="h-56 rounded-lg border bg-card p-5 animate-pulse flex flex-col justify-between"
            >
              <div className="h-6 w-1/2 bg-muted rounded" />
              <div className="space-y-2">
                <div className="h-4 w-3/4 bg-muted rounded" />
                <div className="h-4 w-1/2 bg-muted rounded" />
              </div>
              <div className="h-8 w-full bg-muted rounded" />
            </div>
          ))}
        </div>
      )}

      {/* Empty State */}
      {!loading && hosts.length === 0 && !error && (
        <div className="rounded-lg border border-dashed p-12 text-center flex flex-col items-center justify-center space-y-3">
          <Server className="w-12 h-12 text-muted-foreground" />
          <h3 className="text-lg font-medium">No hosts found</h3>
          <p className="text-sm text-muted-foreground max-w-sm">
            No Proxmox hosts are currently configured in the data directory. Add
            your first host definition to get started.
          </p>
          <Button
            size="sm"
            onClick={() => setShowAddGuidance(true)}
            className="mt-2"
          >
            Show Add Host Instructions
          </Button>
        </div>
      )}

      {/* Hosts Cards Grid */}
      {!loading && hosts.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {hosts.map((host) => {
            const testState = testStates[host.id];
            const hasIssues =
              host.runtime.issues && host.runtime.issues.length > 0;

            return (
              <div
                key={host.id}
                className="rounded-lg border bg-card text-card-foreground shadow-sm flex flex-col justify-between hover:border-primary/50 transition-colors"
              >
                <div className="p-5 space-y-4">
                  {/* Card Header */}
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <h2 className="font-semibold text-lg">{host.name}</h2>
                        <span className="text-xs font-mono bg-muted text-muted-foreground px-1.5 py-0.5 rounded">
                          idx:{host.index}
                        </span>
                      </div>
                      <p className="text-xs font-mono text-muted-foreground mt-0.5">
                        {host.id}
                      </p>
                    </div>
                    {renderStatusBadge(host.status)}
                  </div>

                  {/* Channel Status Matrix */}
                  <div className="grid grid-cols-2 gap-2 text-xs pt-1 border-t">
                    <div className="space-y-1">
                      <span className="text-muted-foreground flex items-center gap-1">
                        SSH Channel
                      </span>
                      <div className="font-medium flex items-center gap-1.5">
                        {host.runtime.ssh.status === 'connected' ? (
                          <span className="text-emerald-500 flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                            Connected
                          </span>
                        ) : (
                          <span className="text-rose-500 flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                            {host.runtime.ssh.status || 'Offline'}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="space-y-1">
                      <span className="text-muted-foreground flex items-center gap-1">
                        API Channel
                      </span>
                      <div className="font-medium flex items-center gap-1.5">
                        {host.runtime.api.configured ? (
                          host.runtime.api.status === 'connected' ? (
                            <span className="text-emerald-500 flex items-center gap-1">
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                              Connected
                            </span>
                          ) : (
                            <span className="text-rose-500 flex items-center gap-1">
                              <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                              {host.runtime.api.status || 'Error'}
                            </span>
                          )
                        ) : (
                          <span className="text-muted-foreground">
                            Not Configured
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Operational States: Vault & Queue */}
                  <div className="flex items-center justify-between text-xs text-muted-foreground pt-1 border-t">
                    <div className="flex items-center gap-1.5">
                      <ShieldCheck className="w-3.5 h-3.5 text-muted-foreground" />
                      <span>Vault:</span>
                      <span className="font-medium text-foreground">
                        {host.runtime.vault.status === 'unlocked'
                          ? 'Unlocked'
                          : host.runtime.vault.status === 'locked'
                            ? 'Locked'
                            : 'Not configured'}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <Activity className="w-3.5 h-3.5 text-muted-foreground" />
                      <span>Queue:</span>
                      <span className="font-medium text-foreground capitalize">
                        {host.runtime.queue.status || 'Idle'}
                      </span>
                    </div>
                  </div>

                  {/* Guest Count */}
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Layers className="w-3.5 h-3.5" />
                    <span>Live Guests:</span>
                    <span className="font-semibold text-foreground">
                      {host.guestCount ?? 0}
                    </span>
                  </div>

                  {/* Probe Warnings / Issues */}
                  {hasIssues && (
                    <div className="rounded bg-amber-500/10 border border-amber-500/20 p-2.5 text-xs text-amber-500 space-y-1">
                      {host.runtime.issues.map((issue, idx) => (
                        <div key={idx} className="flex items-start gap-1.5">
                          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                          <span>{issue}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Connection Test Result Feedback */}
                  {testState?.result && (
                    <div className="rounded bg-muted p-2.5 text-xs space-y-1 font-mono">
                      <div className="flex justify-between">
                        <span>Test Result:</span>
                        <span
                          className={
                            testState.result.ok
                              ? 'text-emerald-500 font-bold'
                              : 'text-rose-500 font-bold'
                          }
                        >
                          {testState.result.ok ? 'OK' : 'FAILED'}
                        </span>
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        SSH:{' '}
                        {testState.result.ssh.ok
                          ? `OK (${testState.result.ssh.latencyMs ?? 0}ms)`
                          : (testState.result.ssh.error ?? 'Failed')}
                        {' | '}
                        API:{' '}
                        {testState.result.api?.ok
                          ? `OK (${testState.result.api.latencyMs ?? 0}ms)`
                          : (testState.result.api?.error ?? 'N/A')}
                      </div>
                    </div>
                  )}
                </div>

                {/* Card Footer Actions */}
                <div className="p-3 bg-muted/40 border-t flex items-center justify-between gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={testState?.testing}
                    onClick={() => handleTestConnection(host.id)}
                    className="text-xs h-8"
                  >
                    {testState?.testing ? (
                      <>
                        <RefreshCw className="w-3 h-3 animate-spin mr-1.5" />
                        Testing...
                      </>
                    ) : (
                      'Test Connection'
                    )}
                  </Button>

                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => navigate(`/hosts/${host.id}`)}
                    className="text-xs h-8 flex items-center gap-1"
                  >
                    View Details
                    <ArrowRight className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

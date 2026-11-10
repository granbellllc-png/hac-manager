import { useEffect, useState, useCallback } from 'react';
import { apiClient } from '../api/client';
import type { paths } from '../api/schema';
import { Button } from '../components/ui/button';

type AuditItem =
  paths['/api/audit']['get']['responses']['200']['content']['application/json']['items'][number];
type AuditReason =
  | 'manual'
  | 'drift_push'
  | 'drift_pull'
  | 'schedule'
  | 'conflict_resolution'
  | 'orphan_action';

export type SafeAuditPayloadResult =
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly error: string };

export function safeFormatAuditPayload(
  diffJson: string | null | undefined,
  metadataJson: string | null | undefined,
): SafeAuditPayloadResult {
  const raw =
    diffJson && diffJson.trim() !== ''
      ? diffJson
      : metadataJson && metadataJson.trim() !== ''
        ? metadataJson
        : null;

  if (!raw) {
    return { ok: false, error: 'Payload could not be decoded.' };
  }

  try {
    const parsed = JSON.parse(raw);
    return { ok: true, content: JSON.stringify(parsed, null, 2) };
  } catch {
    return { ok: false, error: 'Payload could not be decoded.' };
  }
}

export function AuditPage() {
  const [items, setItems] = useState<readonly AuditItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [hostFilter, setHostFilter] = useState('');
  const [vmidFilter, setVmidFilter] = useState('');
  const [userFilter, setUserFilter] = useState('');
  const [reasonFilter, setReasonFilter] = useState<string>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Pagination
  const [page, setPage] = useState(0);
  const pageSize = 20;

  const fetchAuditLogs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const queryParams: Record<string, string | number> = {
        limit: pageSize,
        offset: page * pageSize,
      };

      if (hostFilter.trim()) queryParams.hostId = hostFilter.trim();
      if (vmidFilter.trim() && !Number.isNaN(Number(vmidFilter))) {
        queryParams.vmid = Number(vmidFilter);
      }
      if (userFilter.trim()) queryParams.username = userFilter.trim();
      if (reasonFilter !== 'all') {
        queryParams.reason = reasonFilter as AuditReason;
      }

      const { data, error: apiError } = await apiClient.GET('/api/audit', {
        params: {
          query: queryParams as never,
        },
      });

      if (apiError || !data) {
        setError('Failed to load audit records.');
        return;
      }

      setItems(data.items);
      setTotal(data.total);
    } catch {
      setError('An error occurred while fetching audit records.');
    } finally {
      setLoading(false);
    }
  }, [page, hostFilter, vmidFilter, userFilter, reasonFilter]);

  useEffect(() => {
    void fetchAuditLogs();
  }, [fetchAuditLogs]);

  const handleResetFilters = () => {
    setHostFilter('');
    setVmidFilter('');
    setUserFilter('');
    setReasonFilter('all');
    setPage(0);
  };

  const totalPages = Math.ceil(total / pageSize);

  return (
    <section className="flex flex-col gap-6" aria-label="Audit log page">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Audit</h1>
        <p className="text-sm text-muted-foreground">
          Append-only record of configuration changes, drift syncs, and actions
          with redacted diffs.
        </p>
      </div>

      {/* Filter Bar */}
      <div className="grid grid-cols-1 gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2 md:grid-cols-5">
        <div>
          <label
            htmlFor="audit-filter-host"
            className="block text-xs font-medium text-muted-foreground"
          >
            Host
          </label>
          <input
            id="audit-filter-host"
            type="text"
            placeholder="e.g. pve-01"
            value={hostFilter}
            onChange={(e) => {
              setHostFilter(e.target.value);
              setPage(0);
            }}
            className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
          />
        </div>

        <div>
          <label
            htmlFor="audit-filter-vmid"
            className="block text-xs font-medium text-muted-foreground"
          >
            VMID
          </label>
          <input
            id="audit-filter-vmid"
            type="number"
            placeholder="e.g. 100"
            value={vmidFilter}
            onChange={(e) => {
              setVmidFilter(e.target.value);
              setPage(0);
            }}
            className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
          />
        </div>

        <div>
          <label
            htmlFor="audit-filter-user"
            className="block text-xs font-medium text-muted-foreground"
          >
            User
          </label>
          <input
            id="audit-filter-user"
            type="text"
            placeholder="Username"
            value={userFilter}
            onChange={(e) => {
              setUserFilter(e.target.value);
              setPage(0);
            }}
            className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
          />
        </div>

        <div>
          <label
            htmlFor="audit-filter-reason"
            className="block text-xs font-medium text-muted-foreground"
          >
            Reason
          </label>
          <select
            id="audit-filter-reason"
            value={reasonFilter}
            onChange={(e) => {
              setReasonFilter(e.target.value);
              setPage(0);
            }}
            className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
          >
            <option value="all">All reasons</option>
            <option value="manual">manual</option>
            <option value="drift_push">drift_push</option>
            <option value="drift_pull">drift_pull</option>
            <option value="schedule">schedule</option>
            <option value="conflict_resolution">conflict_resolution</option>
            <option value="orphan_action">orphan_action</option>
          </select>
        </div>

        <div className="flex items-end">
          <Button
            variant="outline"
            size="sm"
            onClick={handleResetFilters}
            className="w-full"
          >
            Reset Filters
          </Button>
        </div>
      </div>

      {/* Audit Log Table */}
      {loading ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          Loading audit logs...
        </div>
      ) : error ? (
        <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-dashed py-12 text-center text-sm text-muted-foreground">
          No audit records found matching your filters.
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-left text-sm" role="table">
              <thead className="border-b bg-muted/50 text-xs font-semibold uppercase text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-3">
                    Timestamp
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Action
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Reason
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Target
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Actor
                  </th>
                  <th scope="col" className="px-4 py-3 text-right">
                    Details
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {items.map((item) => (
                  <tr key={item.id} className="hover:bg-muted/30">
                    <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                      {new Date(item.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 font-medium">
                      <span className="inline-flex items-center rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                        {item.action}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      <span className="rounded bg-secondary px-1.5 py-0.5 text-xs">
                        {item.reason}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {item.hostId ? (
                        <span>
                          {item.hostId}
                          {item.vmid !== null && (
                            <span className="text-muted-foreground">
                              {' '}
                              (VMID {item.vmid})
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {item.username ?? 'system'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {item.diffJson || item.metadataJson ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            setExpandedId(
                              expandedId === item.id ? null : item.id,
                            )
                          }
                        >
                          {expandedId === item.id ? 'Hide' : 'View Diff'}
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Expanded Diff Viewer */}
          {expandedId && (
            <div
              className="rounded-lg border bg-muted/30 p-4"
              data-testid="diff-viewer"
            >
              <div className="flex items-center justify-between pb-2">
                <span className="text-xs font-semibold uppercase text-muted-foreground">
                  Redacted Diff / Payload
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setExpandedId(null)}
                >
                  Close
                </Button>
              </div>
              {(() => {
                const target = items.find((it) => it.id === expandedId);
                if (!target) return null;
                const result = safeFormatAuditPayload(
                  target.diffJson,
                  target.metadataJson,
                );
                if (!result.ok) {
                  return (
                    <div
                      className="rounded bg-destructive/10 p-3 text-xs text-destructive"
                      role="alert"
                    >
                      {result.error}
                    </div>
                  );
                }
                return (
                  <pre className="max-h-64 overflow-auto rounded bg-background p-3 text-xs">
                    {result.content}
                  </pre>
                );
              })()}
            </div>
          )}

          {/* Pagination Controls */}
          <div className="flex items-center justify-between px-2 text-xs text-muted-foreground">
            <div>
              Showing {page * pageSize + 1} to{' '}
              {Math.min((page + 1) * pageSize, total)} of {total} entries
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                Previous
              </Button>
              <span>
                Page {page + 1} of {Math.max(1, totalPages)}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page + 1 >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

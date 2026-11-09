import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import {
  scanDataDir,
  DataDirWatcher,
  loadYamlDocument,
  yamlDocumentToJS,
  parseConfig,
  type HostFile,
  type DiscoveredHost,
} from '@hacm/core';
import type { DatabaseRepositories } from '../db/repositories/types.js';
import type { AuthenticatedUser } from '../auth/session.js';
import type {
  HostDetail,
  HostRegistryEntry,
  HostRuntimeStatus,
  HostSummary,
  HostSyncResult,
  SanitizedApiConnection,
  SanitizedSshConnection,
} from './types.js';

export interface HostRegistryOptions {
  readonly dataDir: string;
  readonly repos: DatabaseRepositories;
  readonly autoWatch?: boolean | undefined;
}

function sanitizeSshConnection(
  ssh: HostFile['connection']['ssh'],
): SanitizedSshConnection {
  const hostVal = typeof ssh.host === 'string' ? ssh.host : String(ssh.host);
  const usernameVal = typeof ssh.username === 'string' ? ssh.username : 'root';
  const authMethod = ssh.private_key
    ? 'key'
    : ssh.password
      ? 'password'
      : 'none';

  return {
    host: hostVal,
    port: ssh.port ?? 22,
    username: usernameVal,
    fingerprint: ssh.fingerprint,
    authMethod,
  };
}

function sanitizeApiConnection(
  api?: HostFile['connection']['api'],
): SanitizedApiConnection | undefined {
  if (!api) return undefined;
  const tokenIdVal =
    typeof api.token_id === 'string' ? api.token_id : String(api.token_id);
  return {
    url: api.url,
    tokenId: tokenIdVal,
    fingerprint: api.fingerprint,
    configured: true,
  };
}

function parseCachedRuntime(
  value: string | null | undefined,
): HostRuntimeStatus | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<HostRuntimeStatus> | null;
    if (!parsed || typeof parsed.overall !== 'string') return undefined;
    return parsed as HostRuntimeStatus;
  } catch {
    return undefined;
  }
}

export class HostRegistry extends EventEmitter {
  public readonly dataDir: string;
  private readonly repos: DatabaseRepositories;
  private readonly hosts = new Map<string, HostRegistryEntry>();
  private readonly watcher?: DataDirWatcher | undefined;
  private isSyncing = false;

  public constructor(options: HostRegistryOptions) {
    super();
    this.dataDir = options.dataDir;
    this.repos = options.repos;

    if (options.autoWatch) {
      this.watcher = new DataDirWatcher(this.dataDir, { debounceMs: 100 });
      this.watcher.on('change', (event) => {
        const affectsHosts = event.changedFiles.some(
          (file: string) =>
            file.startsWith('hosts/') ||
            file.startsWith('hosts\\') ||
            file === 'hosts',
        );
        if (affectsHosts) {
          void this.sync();
        }
      });
      this.watcher.start();
    }
  }

  public async sync(): Promise<HostSyncResult> {
    if (this.isSyncing) {
      return { synced: this.hosts.size, removed: 0, issues: [] };
    }
    this.isSyncing = true;
    try {
      const scan = await scanDataDir(this.dataDir);
      const allIssues = scan.issues;
      const issuesList: string[] = allIssues.map((i) => i.message);

      const discoveredMap = new Map<string, DiscoveredHost>();
      for (const host of scan.dataDir.hosts) {
        discoveredMap.set(host.id, host);
      }

      const cachedHosts = new Map(
        (await this.repos.hostsCache.list()).map((row) => [row.id, row]),
      );

      let syncedCount = 0;

      for (const [hostId, discoveredHost] of discoveredMap.entries()) {
        const hostIssues = allIssues.filter(
          (i) =>
            i.path &&
            (i.path.includes(hostId) || i.message.includes(`"${hostId}"`)),
        );
        let parsedHostConfig: HostFile | undefined = undefined;
        try {
          const content = await readFile(discoveredHost.hostFile, 'utf8');
          const doc = loadYamlDocument(content);
          const parsed = parseConfig('host', yamlDocumentToJS(doc));
          if (parsed.ok) {
            parsedHostConfig = parsed.value;
          }
        } catch (err) {
          hostIssues.push({
            code: 'invalid_config',
            message: `Failed to load host config: ${err instanceof Error ? err.message : String(err)}`,
            path: discoveredHost.relativeHostFile,
          });
        }

        const hasError = hostIssues.length > 0;
        const previous = this.hosts.get(hostId);
        const persistedRuntime =
          previous?.runtime ??
          parseCachedRuntime(cachedHosts.get(hostId)?.runtimeJson);
        const apiConfigured = parsedHostConfig
          ? Boolean(parsedHostConfig.connection.api)
          : (persistedRuntime?.api.configured ?? false);

        const runtimeStatus: HostRuntimeStatus = {
          overall: hasError
            ? 'error'
            : (persistedRuntime?.overall ?? 'unknown'),
          ssh: persistedRuntime?.ssh ?? { status: 'unknown' },
          api: {
            ...(persistedRuntime?.api ?? { status: 'unknown' }),
            configured: apiConfigured,
          },
          vault: persistedRuntime?.vault ?? { status: 'not_configured' },
          queue: persistedRuntime?.queue ?? { status: 'idle' },
          lastSeenAt: persistedRuntime?.lastSeenAt,
          issues: hostIssues.map((i) => i.message),
        };

        if (parsedHostConfig) {
          const config = parsedHostConfig;
          const sanitizedSsh = sanitizeSshConnection(config.connection.ssh);
          const sanitizedApi = sanitizeApiConnection(config.connection.api);

          const safeConfigJson = JSON.stringify({
            id: config.id,
            name: config.name,
            type: config.type,
            index: config.index,
            connection: {
              ssh: sanitizedSsh,
              api: sanitizedApi,
            },
            defaults: config.defaults,
            ignored_guests: config.ignored_guests,
          });

          await this.repos.hostsCache.upsert({
            id: hostId,
            name: config.name,
            type: config.type,
            status: runtimeStatus.overall,
            cachedConfigJson: safeConfigJson,
            runtimeJson: JSON.stringify(runtimeStatus),
            updatedAt: new Date(),
          });

          // Auto-grant access to eligible users for newly added hosts
          await this.repos.userHostAccess.autoGrantHostToEligibleUsers(hostId);

          this.hosts.set(hostId, {
            id: hostId,
            config,
            runtime: runtimeStatus,
            updatedAt: new Date(),
          });
          syncedCount++;
        }
      }

      // Remove hosts that were deleted from disk
      const existingDbHosts = await this.repos.hostsCache.list();
      let removedCount = 0;
      for (const dbHost of existingDbHosts) {
        if (!discoveredMap.has(dbHost.id)) {
          await this.repos.hostsCache.delete(dbHost.id);
          this.hosts.delete(dbHost.id);
          removedCount++;
        }
      }

      const result: HostSyncResult = {
        synced: syncedCount,
        removed: removedCount,
        issues: issuesList,
      };

      this.emit('synced', result);
      return result;
    } finally {
      this.isSyncing = false;
    }
  }

  public async listHosts(
    user?: AuthenticatedUser,
  ): Promise<readonly HostSummary[]> {
    let allowedIds: Set<string> | null = null;
    if (user && user.role !== 'admin') {
      const granted = await this.repos.userHostAccess.getGrantedHostIds(
        user.id,
      );
      allowedIds = new Set(granted);
    }

    const summaries: HostSummary[] = [];
    for (const [id, entry] of this.hosts.entries()) {
      if (allowedIds && !allowedIds.has(id)) {
        continue;
      }
      summaries.push({
        id,
        name: entry.config.name,
        type: 'proxmox',
        index: typeof entry.config.index === 'number' ? entry.config.index : 0,
        status: entry.runtime.overall,
        runtime: entry.runtime,
        updatedAt: entry.updatedAt.toISOString(),
      });
    }

    return summaries.sort((a, b) => a.id.localeCompare(b.id));
  }

  public async getHost(
    id: string,
    user?: AuthenticatedUser,
  ): Promise<HostDetail | undefined> {
    if (user && user.role !== 'admin') {
      const hasAccess = await this.repos.userHostAccess.hasAccess(user.id, id);
      if (!hasAccess) {
        return undefined;
      }
    }

    const entry = this.hosts.get(id);
    if (!entry) return undefined;

    const sanitizedSsh = sanitizeSshConnection(entry.config.connection.ssh);
    const sanitizedApi = sanitizeApiConnection(entry.config.connection.api);

    return {
      id: entry.id,
      name: entry.config.name,
      type: 'proxmox',
      index: typeof entry.config.index === 'number' ? entry.config.index : 0,
      status: entry.runtime.overall,
      runtime: entry.runtime,
      updatedAt: entry.updatedAt.toISOString(),
      connection: {
        ssh: sanitizedSsh,
        api: sanitizedApi,
      },
      ignoredGuestsCount: Array.isArray(entry.config.ignored_guests)
        ? entry.config.ignored_guests.length
        : 0,
      defaults: entry.config.defaults,
    };
  }

  public getRawHost(id: string): HostFile | undefined {
    return this.hosts.get(id)?.config;
  }

  public updateRuntimeStatus(
    id: string,
    patch: Partial<HostRuntimeStatus>,
  ): void {
    const entry = this.hosts.get(id);
    if (!entry) return;

    const updatedRuntime: HostRuntimeStatus = {
      ...entry.runtime,
      ...patch,
      ssh: patch.ssh
        ? { ...entry.runtime.ssh, ...patch.ssh }
        : entry.runtime.ssh,
      api: patch.api
        ? { ...entry.runtime.api, ...patch.api }
        : entry.runtime.api,
      vault: patch.vault
        ? { ...entry.runtime.vault, ...patch.vault }
        : entry.runtime.vault,
      queue: patch.queue
        ? { ...entry.runtime.queue, ...patch.queue }
        : entry.runtime.queue,
      issues: patch.issues ?? entry.runtime.issues,
    };

    this.hosts.set(id, {
      ...entry,
      runtime: updatedRuntime,
      updatedAt: new Date(),
    });

    void (async () => {
      const existing = await this.repos.hostsCache.get(entry.id);
      await this.repos.hostsCache.upsert({
        id: entry.id,
        name: entry.config.name,
        type: entry.config.type,
        status: updatedRuntime.overall,
        lastSeenAt: updatedRuntime.lastSeenAt
          ? new Date(updatedRuntime.lastSeenAt)
          : null,
        cachedConfigJson:
          existing?.cachedConfigJson ??
          JSON.stringify({
            id: entry.config.id,
            name: entry.config.name,
            type: entry.config.type,
            index: entry.config.index,
          }),
        runtimeJson: JSON.stringify(updatedRuntime),
        updatedAt: new Date(),
      });
    })();

    this.emit('statusChanged', { hostId: id, runtime: updatedRuntime });
  }

  public close(): void {
    this.watcher?.close();
  }
}

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  applyPatch,
  computeGuestDrift,
  hashContent,
  loadYamlDocument,
  resolveConfigTags,
  sanitizeAuditPayload,
  toErrorMessage,
  WriteGuard,
  yamlDocumentToJS,
  type DriftChange,
  type GuestDeployment,
} from '@hacm/core';
import type { DatabaseRepositories } from '../db/repositories/types.js';
import type { DriftSnapshotRow } from '../db/schema.js';
import type { HostRegistry } from '../hosts/registry.js';
import {
  collectAdminOnlySurfaces,
  indexConfiguredGuests,
  type AdminOnlyConfigSurface,
} from '../inventory/configuration.js';
import type { LiveInventoryService } from '../inventory/service.js';
import type { ConnectionManager } from '../router/manager.js';
import {
  loadGuestDeployment,
  type LoadedGuestDeployment,
} from '../guests/configuration.js';
import type {
  DriftPullApplied,
  DriftPullFailure,
  DriftPullInput,
  DriftPullResult,
  DriftSnapshot,
  DriftSnapshotFilter,
  HostDriftCheckResult,
} from './types.js';

export class DriftGuestNotFoundError extends Error {
  public constructor(
    message: string,
    public readonly hostId: string,
    public readonly vmid: number,
  ) {
    super(message);
    this.name = 'DriftGuestNotFoundError';
  }
}

export class DriftResolutionForbiddenError extends Error {
  public constructor(
    message: string,
    public readonly adminOnly: readonly AdminOnlyConfigSurface[] = [],
  ) {
    super(message);
    this.name = 'DriftResolutionForbiddenError';
  }
}

export interface DriftServiceOptions {
  readonly repos: DatabaseRepositories;
  readonly hostRegistry: Pick<HostRegistry, 'dataDir' | 'getRawHost'>;
  readonly inventoryService: Pick<LiveInventoryService, 'getGuestLiveConfig'>;
  readonly connections?: Pick<ConnectionManager, 'secretManager'> | undefined;
  readonly now?: (() => Date) | undefined;
  readonly ignoredPaths?: readonly string[] | undefined;
}

function toSnapshot(row: DriftSnapshotRow): DriftSnapshot {
  return {
    id: row.id,
    hostId: row.hostId,
    vmid: row.vmid,
    type: row.guestType,
    status: row.status,
    changes: JSON.parse(row.changesJson) as DriftChange[],
    computedFields: JSON.parse(row.computedFieldsJson) as string[],
    ignoredPaths: JSON.parse(row.ignoredPathsJson) as string[],
    checkedAt: row.checkedAt.toISOString(),
  };
}

async function adminOnlySurfacesForFile(
  filePath: string,
  relativePath: string,
): Promise<readonly AdminOnlyConfigSurface[]> {
  const raw = await readFile(filePath, 'utf8');
  return collectAdminOnlySurfaces(
    yamlDocumentToJS(loadYamlDocument(raw)),
    relativePath,
  );
}

async function loadAdminOnlySurfaces(
  loaded: LoadedGuestDeployment,
): Promise<readonly AdminOnlyConfigSurface[]> {
  const surfaces = new Set<AdminOnlyConfigSurface>();
  for (const surface of await adminOnlySurfacesForFile(
    loaded.deploymentFile,
    loaded.relativePath,
  )) {
    surfaces.add(surface);
  }
  if (loaded.defaultDeploymentFile && loaded.relativeDefaultDeploymentFile) {
    for (const surface of await adminOnlySurfacesForFile(
      loaded.defaultDeploymentFile,
      loaded.relativeDefaultDeploymentFile,
    )) {
      surfaces.add(surface);
    }
  }
  return [...surfaces].sort();
}

/**
 * Coordinates drift checks: evaluate the guest YAML, resolve tags, fetch the
 * live canonical config, compare the two and persist the redacted result.
 */
export class DriftService {
  private readonly repos: DatabaseRepositories;
  private readonly hostRegistry: Pick<HostRegistry, 'dataDir' | 'getRawHost'>;
  private readonly inventoryService: Pick<
    LiveInventoryService,
    'getGuestLiveConfig'
  >;
  private readonly connections:
    Pick<ConnectionManager, 'secretManager'> | undefined;
  private readonly now: () => Date;
  private readonly ignoredPaths: readonly string[] | undefined;

  public constructor(options: DriftServiceOptions) {
    this.repos = options.repos;
    this.hostRegistry = options.hostRegistry;
    this.inventoryService = options.inventoryService;
    this.connections = options.connections;
    this.now = options.now ?? (() => new Date());
    this.ignoredPaths = options.ignoredPaths;
  }

  public async list(
    filter: DriftSnapshotFilter = {},
  ): Promise<readonly DriftSnapshot[]> {
    const rows = await this.repos.driftSnapshots.list({
      ...(filter.hostId ? { hostId: filter.hostId } : {}),
      ...(filter.vmid !== undefined ? { vmid: filter.vmid } : {}),
      ...(filter.statuses ? { statuses: filter.statuses } : {}),
      ...(filter.limit !== undefined ? { limit: filter.limit } : {}),
    });
    return rows.map(toSnapshot);
  }

  public async get(
    hostId: string,
    vmid: number,
  ): Promise<DriftSnapshot | null> {
    const row = await this.repos.driftSnapshots.get(hostId, vmid);
    return row ? toSnapshot(row) : null;
  }

  public async checkGuest(
    hostId: string,
    vmid: number,
  ): Promise<DriftSnapshot> {
    const loaded = await loadGuestDeployment(
      this.hostRegistry.dataDir,
      hostId,
      vmid,
    );
    if (!loaded) {
      throw new DriftGuestNotFoundError(
        `Guest ${vmid} has no deployment YAML on host '${hostId}'`,
        hostId,
        vmid,
      );
    }

    const host = this.hostRegistry.getRawHost(hostId);
    const resolution = await resolveConfigTags<GuestDeployment>(
      loaded.deployment,
      {
        dataDir: this.hostRegistry.dataDir,
        currentFileDir: dirname(
          join(this.hostRegistry.dataDir, loaded.relativePath),
        ),
        env: process.env,
        evaluationContext: {
          host: {
            id: hostId,
            name: host?.name ?? hostId,
            ...(typeof host?.index === 'number' ? { index: host.index } : {}),
          },
          guest: {
            id: loaded.deployment.id,
            name: loaded.deployment.name,
            type: loaded.deployment.type,
          },
          vmid: loaded.deployment.id,
        },
        ...(this.connections
          ? {
              secretProvider: this.connections.secretManager,
              cmdProvider: this.connections.secretManager,
            }
          : {}),
      },
    );

    const live = await this.inventoryService.getGuestLiveConfig(
      hostId,
      vmid,
      loaded.deployment.type,
    );

    const now = this.now();
    const result = computeGuestDrift({
      hostId,
      vmid,
      type: loaded.deployment.type,
      desired: resolution.data,
      live: live.canonicalConfig,
      provenance: loaded.provenance,
      checkedAt: now,
      ...(this.ignoredPaths ? { ignoredPaths: this.ignoredPaths } : {}),
    });

    const row = await this.repos.driftSnapshots.upsert({
      id: randomUUID(),
      hostId,
      vmid,
      guestType: loaded.deployment.type,
      status: result.status,
      changesJson: JSON.stringify(result.changes),
      computedFieldsJson: JSON.stringify(result.computedFields),
      ignoredPathsJson: JSON.stringify(result.ignoredPaths),
      checkedAt: new Date(result.checkedAt),
      updatedAt: now,
    });
    return toSnapshot(row);
  }

  /**
   * Pull live values into the guest YAML through the CST writeback layer.
   *
   * Only changes marked `pullable` can be written. Computed tag values,
   * secret-valued fields and fields missing from live state are refused.
   */
  public async pull(
    hostId: string,
    vmid: number,
    input: DriftPullInput,
  ): Promise<DriftPullResult> {
    if (input.user.role === 'viewer') {
      throw new DriftResolutionForbiddenError(
        'Viewer role cannot resolve drift',
      );
    }

    const loaded = await loadGuestDeployment(
      this.hostRegistry.dataDir,
      hostId,
      vmid,
    );
    if (!loaded) {
      throw new DriftGuestNotFoundError(
        `Guest ${vmid} has no deployment YAML on host '${hostId}'`,
        hostId,
        vmid,
      );
    }

    if (input.user.role !== 'admin') {
      const adminOnly = await loadAdminOnlySurfaces(loaded);
      if (adminOnly.length > 0) {
        throw new DriftResolutionForbiddenError(
          `Pulling into this guest YAML is restricted to administrators because it contains admin-only surfaces: ${adminOnly.join(', ')}`,
          adminOnly,
        );
      }
    }

    const snapshot = await this.checkGuest(hostId, vmid);
    const dryRun = input.dryRun ?? false;
    const failures: DriftPullFailure[] = [];
    const applied: DriftPullApplied[] = [];

    const requested = input.paths ? [...new Set(input.paths)] : undefined;
    const byPath = new Map(
      snapshot.changes.map((change) => [change.path, change]),
    );
    const selected: DriftChange[] = [];
    if (requested) {
      for (const path of requested) {
        const change = byPath.get(path);
        if (!change) {
          failures.push({
            path,
            reason: 'path_not_found',
            message: `No drift change exists for path '${path}'`,
          });
          continue;
        }
        selected.push(change);
      }
    } else {
      selected.push(...snapshot.changes);
    }

    const writeGuard = new WriteGuard();
    if (!dryRun) {
      for (const filePath of [
        loaded.deploymentFile,
        loaded.defaultDeploymentFile,
      ]) {
        if (!filePath) continue;
        writeGuard.registerHash(
          filePath,
          await hashContent(await readFile(filePath, 'utf8')),
        );
      }
    }

    const target = {
      deploymentFile: loaded.deploymentFile,
      relativeDeploymentFile: loaded.relativePath,
      ...(loaded.defaultDeploymentFile && loaded.relativeDefaultDeploymentFile
        ? {
            defaultDeploymentFile: loaded.defaultDeploymentFile,
            relativeDefaultDeploymentFile: loaded.relativeDefaultDeploymentFile,
          }
        : {}),
    };

    for (const change of selected) {
      if (!change.pullable) {
        failures.push({
          path: change.path,
          reason: 'not_pullable',
          message: `Field '${change.path}' is computed or secret-valued and cannot be pulled from live state`,
        });
        continue;
      }
      if (change.kind === 'missing_in_live') {
        failures.push({
          path: change.path,
          reason: 'missing_in_live',
          message: `Field '${change.path}' is absent from live state; removing it from YAML is not supported`,
        });
        continue;
      }

      const patchPath = change.provenance?.sourcePath || change.path;
      try {
        const result = await applyPatch(target, patchPath, change.actual, {
          dryRun,
          ...(dryRun ? {} : { writeGuard }),
        });
        if (result.success) {
          applied.push({
            path: change.path,
            targetFile: result.targetFile,
            layer: result.layer,
            previousValue: result.previousValue,
            newValue: result.newValue,
          });
        } else {
          failures.push({
            path: change.path,
            reason: result.reason,
            message: result.message,
          });
        }
      } catch (error) {
        failures.push({
          path: change.path,
          reason: 'apply_failed',
          message: toErrorMessage(error),
        });
      }
    }

    if (!dryRun && (applied.length > 0 || failures.length > 0)) {
      await this.repos.auditLogs.append({
        userId: input.user.id,
        hostId,
        vmid,
        action: 'drift.pull',
        reason: 'drift_pull',
        diff: sanitizeAuditPayload({
          applied: applied.map((entry) => ({
            path: entry.path,
            targetFile: entry.targetFile,
            layer: entry.layer,
            previousValue: entry.previousValue,
            newValue: entry.newValue,
          })),
          failures: failures.map((entry) => ({
            path: entry.path,
            reason: entry.reason,
          })),
        }),
        metadata: {
          paths: applied.map((entry) => entry.path),
        },
      });
    }

    return {
      hostId,
      vmid,
      dryRun,
      applied,
      failures,
      snapshot: dryRun ? snapshot : await this.checkGuest(hostId, vmid),
    };
  }

  public async checkHost(hostId: string): Promise<HostDriftCheckResult> {
    const index = await indexConfiguredGuests(this.hostRegistry.dataDir);
    const vmids = [...index.values()]
      .filter((entry) => entry.hostId === hostId)
      .map((entry) => entry.vmid)
      .sort((a, b) => a - b);

    const snapshots: DriftSnapshot[] = [];
    const failures: { vmid: number; message: string }[] = [];
    for (const vmid of vmids) {
      try {
        snapshots.push(await this.checkGuest(hostId, vmid));
      } catch (error) {
        failures.push({ vmid, message: toErrorMessage(error) });
      }
    }

    return {
      hostId,
      checked: vmids.length,
      snapshots,
      failures,
    };
  }
}

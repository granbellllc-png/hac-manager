import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  computeGuestDrift,
  resolveConfigTags,
  toErrorMessage,
  type DriftChange,
  type GuestDeployment,
} from '@hacm/core';
import type { DatabaseRepositories } from '../db/repositories/types.js';
import type { DriftSnapshotRow } from '../db/schema.js';
import type { HostRegistry } from '../hosts/registry.js';
import { indexConfiguredGuests } from '../inventory/configuration.js';
import type { LiveInventoryService } from '../inventory/service.js';
import type { ConnectionManager } from '../router/manager.js';
import { loadGuestDeployment } from '../guests/configuration.js';
import type {
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

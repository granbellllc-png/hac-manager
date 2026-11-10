import {
  createStorageResolutionSteps,
  inspectStorageInvariants,
  runJournaledSteps,
  sanitizeAuditPayload,
  storageResolutionFromLabel,
  storageResolutionTimestamp,
  STORAGE_RESOLUTION_LABELS,
  type GuestDeployment,
  type StorageInvariantReport,
  type StorageResolution,
} from '@hacm/core';
import type { JobRow } from '../db/schema.js';
import type { DatabaseRepositories } from '../db/repositories/types.js';
import { loadGuestDeployment } from '../guests/configuration.js';
import type { HostRegistry } from '../hosts/registry.js';
import {
  createJobStepLogger,
  DatabaseStepJournal,
} from '../jobs/step-journal.js';
import type { DurableJobQueue } from '../jobs/queue.js';
import type { JobExecutionContext } from '../jobs/types.js';
import type { ConnectionManager } from '../router/manager.js';
import type { HostConnectionRouter } from '../router/router.js';

export const STORAGE_INVARIANT_JOB_TYPE = 'guest.storage.invariant';

export interface StorageInvariantJobPayload {
  readonly vmid: number;
  readonly resolution?: StorageResolution | undefined;
}

export interface StorageInvariantPromptPayload {
  readonly vmid: number;
  readonly guestName: string;
  readonly status: StorageInvariantReport['status'];
  readonly guestPath: string;
  readonly hostPath: string;
  readonly mounted: boolean;
  readonly host: StorageInvariantReport['host'];
  readonly rootfs: StorageInvariantReport['rootfs'];
  readonly staleDaemons: StorageInvariantReport['staleDaemons'];
  readonly recommendedResolution: StorageResolution | undefined;
}

export interface EnqueueStorageInvariantInput {
  readonly hostId: string;
  readonly vmid: number;
  readonly resolution?: StorageResolution | undefined;
  readonly triggeredBy?: string | undefined;
}

export class StorageGuestNotFoundError extends Error {
  public constructor(
    public readonly hostId: string,
    public readonly vmid: number,
  ) {
    super(
      `Guest ${vmid} was not found in the deployment YAML for host '${hostId}'`,
    );
    this.name = 'StorageGuestNotFoundError';
  }
}

export class StorageInvariantJobError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'StorageInvariantJobError';
  }
}

export interface StorageInvariantServiceOptions {
  readonly repos: DatabaseRepositories;
  readonly queue: Pick<DurableJobQueue, 'enqueue' | 'registerHandler'>;
  readonly hostRegistry: Pick<HostRegistry, 'dataDir'>;
  readonly connections: Pick<ConnectionManager, 'getRouter'>;
  readonly now?: (() => Date) | undefined;
}

function parsePayload(value: unknown): StorageInvariantJobPayload {
  if (typeof value !== 'object' || value === null) {
    throw new StorageInvariantJobError(
      'Storage invariant job payload is missing',
    );
  }
  const payload = value as { vmid?: unknown; resolution?: unknown };
  if (
    typeof payload.vmid !== 'number' ||
    !Number.isSafeInteger(payload.vmid) ||
    payload.vmid < 1
  ) {
    throw new StorageInvariantJobError(
      'Storage invariant job payload must contain a positive vmid',
    );
  }
  return {
    vmid: payload.vmid,
    ...(payload.resolution === 'keep-host-data' ||
    payload.resolution === 'migrate-rootfs-to-host'
      ? { resolution: payload.resolution }
      : {}),
  };
}

function resolutionFromPrompt(response: unknown): StorageResolution {
  if (typeof response !== 'object' || response === null) {
    throw new StorageInvariantJobError(
      'The storage resolution prompt returned no choice',
    );
  }
  const choice = (response as { choice?: unknown }).choice;
  const resolution =
    typeof choice === 'string' ? storageResolutionFromLabel(choice) : undefined;
  if (!resolution) {
    throw new StorageInvariantJobError(
      `Storage resolution choice '${String(choice)}' is not supported`,
    );
  }
  return resolution;
}

function promptPayload(
  report: StorageInvariantReport,
): StorageInvariantPromptPayload {
  return {
    vmid: report.vmid,
    guestName: report.guestName,
    status: report.status,
    guestPath: report.guestPath,
    hostPath: report.hostPath,
    mounted: report.mounted,
    host: report.host,
    rootfs: report.rootfs,
    staleDaemons: report.staleDaemons,
    recommendedResolution: report.recommendedResolution,
  };
}

function describeSide(
  label: string,
  summary: StorageInvariantReport['host'],
): string {
  return `${label}: ${summary.fileCount} entries, ${summary.bytes} bytes, newest ${summary.newestTimestamp ?? 'not reported'}`;
}

export class StorageInvariantService {
  private readonly now: () => Date;

  public constructor(private readonly options: StorageInvariantServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  public registerQueueHandler(): void {
    this.options.queue.registerHandler(STORAGE_INVARIANT_JOB_TYPE, (context) =>
      this.executeJob(context),
    );
  }

  public async enqueueCheck(
    input: EnqueueStorageInvariantInput,
  ): Promise<JobRow> {
    await this.assertGuestExists(input.hostId, input.vmid);
    return this.options.queue.enqueue({
      hostId: input.hostId,
      vmid: input.vmid,
      type: STORAGE_INVARIANT_JOB_TYPE,
      reason: 'manual',
      payload: { vmid: input.vmid } satisfies StorageInvariantJobPayload,
      priority: 'low',
      ...(input.triggeredBy !== undefined
        ? { triggeredBy: input.triggeredBy }
        : {}),
    });
  }

  public async enqueueResolution(
    input: EnqueueStorageInvariantInput,
  ): Promise<JobRow> {
    if (!input.resolution) {
      throw new StorageInvariantJobError('A resolution is required');
    }
    await this.assertGuestExists(input.hostId, input.vmid);
    return this.options.queue.enqueue({
      hostId: input.hostId,
      vmid: input.vmid,
      type: STORAGE_INVARIANT_JOB_TYPE,
      reason: 'conflict_resolution',
      payload: {
        vmid: input.vmid,
        resolution: input.resolution,
      } satisfies StorageInvariantJobPayload,
      priority: 'high',
      ...(input.triggeredBy !== undefined
        ? { triggeredBy: input.triggeredBy }
        : {}),
    });
  }

  public async inspect(
    hostId: string,
    vmid: number,
  ): Promise<StorageInvariantReport> {
    const { deployment, transport } = await this.loadTarget(hostId, vmid);
    return inspectStorageInvariants(deployment, transport, {
      hostId,
      now: this.now,
    });
  }

  public async executeJob(context: JobExecutionContext): Promise<void> {
    const payload = parsePayload(context.payload);
    const { deployment, transport } = await this.loadTarget(
      context.job.hostId,
      payload.vmid,
    );
    const report = await inspectStorageInvariants(deployment, transport, {
      hostId: context.job.hostId,
      now: this.now,
    });

    await context.log('system', `Storage invariant status: ${report.status}`);
    await context.log('system', report.message);
    await context.log('system', describeSide('Host data', report.host));
    await context.log('system', describeSide('Rootfs copy', report.rootfs));
    for (const warning of report.warnings) {
      await context.log('stderr', `Warning: ${warning}`);
    }

    if (!report.requiresResolution) {
      await this.audit(context, payload.vmid, report, undefined);
      return;
    }

    const resolution =
      payload.resolution ??
      resolutionFromPrompt(
        await context.prompt({
          kind: 'choice',
          message: `Storage ${report.status} detected for LXC ${payload.vmid} (${deployment.name}) at ${report.guestPath}. Choose which side to keep; the other side is archived first.`,
          payload: promptPayload(report),
          options: report.resolutionOptions.map(
            (option) => STORAGE_RESOLUTION_LABELS[option],
          ),
        }),
      );

    await context.log(
      'system',
      `Applying storage resolution: ${STORAGE_RESOLUTION_LABELS[resolution]}`,
    );
    const steps = createStorageResolutionSteps(deployment, report, resolution, {
      timestamp: storageResolutionTimestamp(context.job.createdAt),
    });
    await runJournaledSteps({
      operationId: context.job.id,
      input: undefined,
      transport,
      logger: createJobStepLogger(context.log),
      dryRun: false,
      signal: context.signal,
      journal: new DatabaseStepJournal(this.options.repos),
      steps,
    });
    await this.audit(context, payload.vmid, report, resolution);
  }

  private async assertGuestExists(hostId: string, vmid: number): Promise<void> {
    const loaded = await loadGuestDeployment(
      this.options.hostRegistry.dataDir,
      hostId,
      vmid,
    );
    if (!loaded) throw new StorageGuestNotFoundError(hostId, vmid);
  }

  private async loadTarget(
    hostId: string,
    vmid: number,
  ): Promise<{
    readonly deployment: GuestDeployment;
    readonly transport: HostConnectionRouter;
  }> {
    const loaded = await loadGuestDeployment(
      this.options.hostRegistry.dataDir,
      hostId,
      vmid,
    );
    if (!loaded) throw new StorageGuestNotFoundError(hostId, vmid);
    const transport = await this.options.connections.getRouter(hostId);
    return { deployment: loaded.deployment, transport };
  }

  private async audit(
    context: JobExecutionContext,
    vmid: number,
    report: StorageInvariantReport,
    resolution: StorageResolution | undefined,
  ): Promise<void> {
    await this.options.repos.auditLogs.append({
      userId: null,
      hostId: context.job.hostId,
      vmid,
      action:
        resolution === undefined
          ? 'guest.storage.check'
          : 'guest.storage.resolve',
      reason: 'conflict_resolution',
      jobId: context.job.id,
      diff: sanitizeAuditPayload({
        status: report.status,
        guestPath: report.guestPath,
        hostPath: report.hostPath,
        host: report.host,
        rootfs: report.rootfs,
        ...(resolution !== undefined ? { resolution } : {}),
      }),
      metadata: {
        checkedAt: report.checkedAt,
        mounted: report.mounted,
      },
    });
  }
}

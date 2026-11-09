import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  applyGuestImport,
  assertPlanFresh,
  createLxcProvisionSteps,
  createLxcUpdateSteps,
  createMutationPlan,
  deploymentDefaultsFileSchema,
  describeLxcCreation,
  executeMutationPlan,
  hashContent,
  isManagedGuestTag,
  loadYamlDocument,
  lxcUpdateState,
  managedGuestUuid,
  parseManagedGuestUuid,
  planGuestImport,
  planLxcUpdate,
  resolveConfigTags,
  runJournaledSteps,
  sanitizeAuditPayload,
  StalePlanError,
  toErrorMessage,
  type DeploymentDefaultsFile,
  type GuestDeployment,
  type GuestImportPlan,
  type MutationPlan,
  type JournaledStep,
  type PlanChange,
  type Transport,
} from '@hacm/core';
import type { DatabaseRepositories } from '../db/repositories/types.js';
import type { PlanRow } from '../db/schema.js';
import {
  GuestLifecycleService,
  type GuestPowerAction,
} from '../guests/service.js';
import { loadGuestDeployment } from '../guests/configuration.js';
import type { GuestSnapshot } from '../guests/types.js';
import type { HostRegistry } from '../hosts/registry.js';
import type { LiveInventoryService } from '../inventory/service.js';
import { parseGuestConfigurationForEditor } from '../inventory/configuration.js';
import {
  DatabaseStepJournal,
  createJobStepLogger,
} from '../jobs/step-journal.js';
import type { DurableJobQueue } from '../jobs/queue.js';
import type { JobExecutionContext } from '../jobs/types.js';
import type { ConnectionManager } from '../router/manager.js';
import {
  PlanConfirmationError,
  PlanAdminRequiredError,
  PlanNotFoundError,
  PlanOverwriteRequiredError,
  PlanStateError,
  type CreateGuestCreatePlanInput,
  type CreateGuestImportPlanInput,
  type CreateGuestPowerPlanInput,
  type CreateGuestStampPlanInput,
  type CreateGuestUpdatePlanInput,
  type GuestCreatePlanPayload,
  type GuestImportPlanPayload,
  type GuestPowerPlanPayload,
  type GuestStampPlanPayload,
  type GuestUpdatePlanPayload,
  type PublicPlan,
  type QueuePlanApplyInput,
  type QueuePlanApplyResult,
} from './types.js';

interface TargetState {
  readonly exists: boolean;
  readonly hash: string | null;
  readonly value: unknown;
  readonly requiresAdmin: boolean;
}

interface GuestImportSnapshot {
  readonly importPlan: GuestImportPlan;
  readonly currentState: unknown;
  readonly target: TargetState;
  readonly after: unknown;
}

interface GuestCreateSnapshot {
  readonly deployment: GuestDeployment | null;
  readonly relativePath: string | null;
  readonly occupiedBy: 'lxc' | 'vm' | null;
}

function createCurrentState(
  vmid: number,
  snapshot: GuestCreateSnapshot,
): unknown {
  return {
    vmid,
    exists: snapshot.occupiedBy !== null,
    type: snapshot.occupiedBy ?? 'lxc',
    deployment: snapshot.deployment,
  };
}

function collisionMessage(hostId: string, vmid: number): string {
  return `VMID ${vmid} is already occupied by a different workload on host '${hostId}'. Refusing to create over it.`;
}

const unavailableTransport: Transport = {
  async exec() {
    throw new PlanStateError('This local plan step cannot execute commands');
  },
  async readFile() {
    throw new PlanStateError('This local plan step cannot read remote files');
  },
  async writeFile() {
    throw new PlanStateError('This local plan step cannot write remote files');
  },
};

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function isMissingFile(error: unknown): boolean {
  return (error as { code?: string }).code === 'ENOENT';
}

function stampFieldsOf(snapshot: GuestSnapshot): {
  readonly description: string;
  readonly tags: readonly string[];
} {
  const description = snapshot.deployment.extra?.['description'];
  return {
    description: typeof description === 'string' ? description : '',
    tags: [...(snapshot.deployment.tags ?? [])].sort(),
  };
}

/**
 * Stable part of a guest used to fingerprint lifecycle plans. Power state is
 * deliberately excluded: restarting a guest between planning and applying must
 * not make an otherwise safe power plan stale.
 */
function lifecycleState(snapshot: GuestSnapshot): unknown {
  return {
    exists: true,
    type: snapshot.type,
    name: snapshot.deployment.name,
    ...stampFieldsOf(snapshot),
    expectedUuid: managedGuestUuid(snapshot.hostId, snapshot.vmid),
  };
}

function rowToMutationPlan(row: PlanRow): MutationPlan {
  return {
    schemaVersion: 1,
    id: row.id,
    operation: row.operation,
    target: {
      hostId: row.hostId,
      ...(row.vmid !== null ? { vmid: row.vmid } : {}),
      resourceType: row.vmid === null ? 'host' : 'guest',
    },
    summary: row.summary,
    changes: parseJson<readonly PlanChange[]>(row.changesJson, []),
    warnings: parseJson<readonly string[]>(row.warningsJson, []),
    destructive: row.destructive,
    stateFingerprint: row.stateFingerprint,
    ...(row.confirmationText !== null
      ? { confirmationText: row.confirmationText }
      : {}),
    createdAt: row.createdAt.toISOString(),
  };
}

function rowToPublicPlan(row: PlanRow): PublicPlan {
  return {
    ...rowToMutationPlan(row),
    status: row.status,
    ...(row.createdBy !== null ? { createdBy: row.createdBy } : {}),
    ...(row.approvedBy !== null ? { approvedBy: row.approvedBy } : {}),
    ...(row.lastJobId !== null ? { lastJobId: row.lastJobId } : {}),
    ...(row.error !== null ? { error: row.error } : {}),
    ...(row.approvedAt !== null
      ? { approvedAt: row.approvedAt.toISOString() }
      : {}),
    ...(row.appliedAt !== null
      ? { appliedAt: row.appliedAt.toISOString() }
      : {}),
  };
}

export class PlanService {
  public constructor(
    private readonly repos: DatabaseRepositories,
    private readonly queue: DurableJobQueue,
    private readonly inventoryService: Pick<
      LiveInventoryService,
      'getGuestLiveConfig'
    >,
    private readonly hostRegistry: Pick<HostRegistry, 'dataDir'> &
      Partial<Pick<HostRegistry, 'getRawHost'>>,
    private readonly lifecycle?: GuestLifecycleService | undefined,
    private readonly connections?:
      Pick<ConnectionManager, 'getRouter' | 'secretManager'> | undefined,
  ) {}

  public registerQueueHandler(): void {
    this.queue.registerHandler('plan.apply', (context) =>
      this.executeJob(context),
    );
  }

  public async createGuestImportPlan(
    input: CreateGuestImportPlanInput,
  ): Promise<PublicPlan> {
    const generatedAt = new Date();
    const snapshot = await this.buildGuestImportSnapshot(
      input.hostId,
      input.vmid,
      generatedAt,
    );
    const overwrite = input.overwrite ?? false;
    if (snapshot.target.exists && !overwrite) {
      throw new PlanOverwriteRequiredError(snapshot.importPlan.relativeFile);
    }
    const destructive = snapshot.target.exists;
    if (snapshot.target.requiresAdmin && input.createdByRole !== 'admin') {
      throw new PlanAdminRequiredError();
    }
    const warnings = [
      ...(snapshot.importPlan.omittedDefaults.length > 0
        ? [
            `Omitted values matching host defaults: ${snapshot.importPlan.omittedDefaults.join(', ')}`,
          ]
        : []),
      ...(destructive
        ? ['The existing deployment YAML will be atomically replaced.']
        : []),
    ];
    const plan = createMutationPlan({
      id: randomUUID(),
      operation: 'guest.import',
      target: {
        hostId: input.hostId,
        vmid: input.vmid,
        resourceType: 'guest',
      },
      summary: `${destructive ? 'Replace' : 'Create'} YAML for ${snapshot.importPlan.type.toUpperCase()} ${input.vmid} (${snapshot.importPlan.name})`,
      currentState: snapshot.currentState,
      changes: [
        {
          id: 'deployment-file',
          action: destructive ? 'update' : 'create',
          path: snapshot.importPlan.relativeFile,
          summary: `${destructive ? 'Replace' : 'Create'} deployment.yaml`,
          before: snapshot.target.exists ? snapshot.target.value : null,
          after: snapshot.after,
          warnings,
          destructive,
        },
      ],
      warnings,
      createdAt: generatedAt,
      ...(destructive
        ? { confirmationText: `OVERWRITE ${input.hostId}/${input.vmid}` }
        : {}),
    });
    const row = await this.repos.plans.create({
      id: plan.id,
      operation: plan.operation,
      hostId: input.hostId,
      vmid: input.vmid,
      status: 'ready',
      summary: plan.summary,
      changesJson: JSON.stringify(plan.changes),
      warningsJson: JSON.stringify(plan.warnings),
      destructive: plan.destructive,
      stateFingerprint: plan.stateFingerprint,
      confirmationText: plan.confirmationText ?? null,
      payloadJson: JSON.stringify({
        overwrite,
        generatedAt: generatedAt.toISOString(),
        requiresAdmin: snapshot.target.requiresAdmin,
      } satisfies GuestImportPlanPayload),
      createdBy: input.createdBy ?? null,
      createdAt: new Date(plan.createdAt),
    });
    return rowToPublicPlan(row);
  }

  public async createGuestPowerPlan(
    input: CreateGuestPowerPlanInput,
  ): Promise<PublicPlan> {
    const lifecycle = this.requireLifecycle();
    const snapshot = await lifecycle.verifyForMutation(
      input.hostId,
      input.vmid,
      {
        operation: `guest.power.${input.action}`,
        runIdentityChecks: false,
      },
    );
    const targetStatus: 'running' | 'stopped' =
      input.action === 'start' || input.action === 'reboot'
        ? 'running'
        : 'stopped';
    const destructive = input.action !== 'start';
    const generatedAt = new Date();
    const currentState = lifecycleState(snapshot);
    const plan = createMutationPlan({
      id: randomUUID(),
      operation: 'guest.power',
      target: {
        hostId: input.hostId,
        vmid: input.vmid,
        resourceType: 'guest',
      },
      summary: `${input.action[0]!.toUpperCase()}${input.action.slice(1)} guest ${input.vmid} (${snapshot.deployment.name})`,
      currentState,
      changes: [
        {
          id: 'power',
          action: 'execute',
          summary: `Set guest ${input.vmid} power state to '${targetStatus}' (${input.action})`,
          before: { status: snapshot.status },
          after: { status: targetStatus },
          warnings:
            input.action === 'stop'
              ? ['A hard stop may lose unsaved data inside the guest.']
              : [],
          destructive,
        },
      ],
      warnings:
        input.action === 'reboot'
          ? [
              'The guest will restart. Long-running work inside it may be interrupted.',
            ]
          : input.action === 'stop'
            ? ['A hard stop may lose unsaved data inside the guest.']
            : [],
      createdAt: generatedAt,
      ...(destructive
        ? {
            confirmationText: `${input.action.toUpperCase()} ${input.hostId}/${input.vmid}`,
          }
        : {}),
    });
    const payload: GuestPowerPlanPayload = {
      action: input.action,
      targetStatus,
      generatedAt: generatedAt.toISOString(),
    };
    const row = await this.repos.plans.create({
      id: plan.id,
      operation: plan.operation,
      hostId: input.hostId,
      vmid: input.vmid,
      status: 'ready',
      summary: plan.summary,
      changesJson: JSON.stringify(plan.changes),
      warningsJson: JSON.stringify(plan.warnings),
      destructive: plan.destructive,
      stateFingerprint: plan.stateFingerprint,
      confirmationText: plan.confirmationText ?? null,
      payloadJson: JSON.stringify(payload),
      createdBy: input.createdBy ?? null,
      createdAt: new Date(plan.createdAt),
    });
    return rowToPublicPlan(row);
  }

  public async createGuestStampPlan(
    input: CreateGuestStampPlanInput,
  ): Promise<PublicPlan> {
    const lifecycle = this.requireLifecycle();
    const snapshot = await lifecycle.verifyForMutation(
      input.hostId,
      input.vmid,
      {
        operation: 'guest.stamp',
        runIdentityChecks: false,
        requireManaged: false,
      },
    );
    const stamped = await lifecycle.stampGuest(input.hostId, input.vmid, {
      dryRun: true,
    });
    if (!stamped.changed) {
      throw new PlanStateError(
        `Guest ${input.vmid} already carries the current management stamp`,
      );
    }
    const generatedAt = new Date();
    const plan = createMutationPlan({
      id: randomUUID(),
      operation: 'guest.stamp',
      target: {
        hostId: input.hostId,
        vmid: input.vmid,
        resourceType: 'guest',
      },
      summary: `Stamp guest ${input.vmid} (${snapshot.deployment.name}) as managed`,
      currentState: lifecycleState(snapshot),
      changes: [
        {
          id: 'stamp',
          action: 'update',
          summary: 'Add management tag and UUID stamp to Proxmox metadata',
          before: {
            tags: snapshot.deployment.tags ?? [],
            description: snapshot.deployment.extra?.['description'] ?? '',
          },
          after: {
            tags: stamped.tags,
            description: stamped.description,
          },
        },
      ],
      warnings: [],
      createdAt: generatedAt,
    });
    const payload: GuestStampPlanPayload = {
      generatedAt: generatedAt.toISOString(),
    };
    const row = await this.repos.plans.create({
      id: plan.id,
      operation: plan.operation,
      hostId: input.hostId,
      vmid: input.vmid,
      status: 'ready',
      summary: plan.summary,
      changesJson: JSON.stringify(plan.changes),
      warningsJson: JSON.stringify(plan.warnings),
      destructive: plan.destructive,
      stateFingerprint: plan.stateFingerprint,
      confirmationText: plan.confirmationText ?? null,
      payloadJson: JSON.stringify(payload),
      createdBy: input.createdBy ?? null,
      createdAt: new Date(plan.createdAt),
    });
    return rowToPublicPlan(row);
  }

  public async createGuestCreatePlan(
    input: CreateGuestCreatePlanInput,
  ): Promise<PublicPlan> {
    if (input.createdByRole !== 'admin') {
      throw new PlanAdminRequiredError(
        'Creating guests is restricted to administrators',
      );
    }
    const snapshot = await this.buildGuestCreateSnapshot(
      input.hostId,
      input.vmid,
    );
    if (!snapshot.deployment) {
      throw new PlanStateError(
        `No deployment YAML is configured for guest ${input.vmid} on host '${input.hostId}'`,
      );
    }
    if (snapshot.deployment.type !== 'lxc') {
      throw new PlanStateError(
        `Guest ${input.vmid} is a VM; LXC creation only supports deployments with type 'lxc'`,
      );
    }
    if (snapshot.occupiedBy) {
      throw new PlanStateError(collisionMessage(input.hostId, input.vmid));
    }
    const preview = describeLxcCreation(snapshot.deployment, {
      hostId: input.hostId,
    });
    const generatedAt = new Date();
    const currentState = createCurrentState(input.vmid, snapshot);
    const plan = createMutationPlan({
      id: randomUUID(),
      operation: 'guest.create',
      target: {
        hostId: input.hostId,
        vmid: input.vmid,
        resourceType: 'guest',
      },
      summary: preview.summary,
      currentState,
      changes: [
        {
          id: 'create-guest',
          action: 'create',
          summary: preview.summary,
          before: null,
          after: {
            vmid: snapshot.deployment.id,
            name: snapshot.deployment.name,
            type: snapshot.deployment.type,
            template: preview.template.volid,
            deployment: snapshot.deployment,
          },
          warnings: [...preview.warnings],
          destructive: false,
        },
      ],
      warnings: [...preview.warnings],
      createdAt: generatedAt,
    });
    const payload: GuestCreatePlanPayload = {
      relativePath: snapshot.relativePath ?? '',
      generatedAt: generatedAt.toISOString(),
    };
    const row = await this.repos.plans.create({
      id: plan.id,
      operation: plan.operation,
      hostId: input.hostId,
      vmid: input.vmid,
      status: 'ready',
      summary: plan.summary,
      changesJson: JSON.stringify(plan.changes),
      warningsJson: JSON.stringify(plan.warnings),
      destructive: plan.destructive,
      stateFingerprint: plan.stateFingerprint,
      confirmationText: plan.confirmationText ?? null,
      payloadJson: JSON.stringify(payload),
      createdBy: input.createdBy ?? null,
      createdAt: new Date(plan.createdAt),
    });
    return rowToPublicPlan(row);
  }

  public async createGuestUpdatePlan(
    input: CreateGuestUpdatePlanInput,
  ): Promise<PublicPlan> {
    const lifecycle = this.requireLifecycle();
    const loaded = await this.loadResolvedGuestDeployment(
      input.hostId,
      input.vmid,
    );
    if (!loaded) {
      throw new PlanStateError(
        `No deployment YAML is configured for guest ${input.vmid} on host '${input.hostId}'`,
      );
    }
    if (loaded.deployment.type !== 'lxc') {
      throw new PlanStateError(
        `Guest ${input.vmid} is a VM; LXC config updates only support deployments with type 'lxc'`,
      );
    }
    const snapshot = await lifecycle.requireSnapshot(input.hostId, input.vmid);
    if (snapshot.deployment.type !== 'lxc') {
      throw new PlanStateError(
        `Guest ${input.hostId}/${input.vmid} is not an LXC container`,
      );
    }
    const diff = planLxcUpdate(loaded.deployment, snapshot.deployment);
    if (diff.blocked) {
      throw new PlanStateError(diff.blockReason ?? 'Update is blocked');
    }
    await lifecycle.verifyForMutation(input.hostId, input.vmid, {
      operation: 'guest.update',
      allowProtected: !diff.destructive,
    });
    if (diff.changes.length === 0) {
      throw new PlanStateError(
        `Guest ${input.hostId}/${input.vmid} already matches its YAML configuration`,
      );
    }
    const generatedAt = new Date();
    const plan = createMutationPlan({
      id: randomUUID(),
      operation: 'guest.update',
      target: {
        hostId: input.hostId,
        vmid: input.vmid,
        resourceType: 'guest',
      },
      summary: diff.summary,
      currentState: lxcUpdateState(loaded.deployment, snapshot.deployment),
      changes: diff.changes,
      warnings: diff.warnings,
      createdAt: generatedAt,
      ...(diff.destructive
        ? { confirmationText: `UPDATE ${input.hostId}/${input.vmid}` }
        : {}),
    });
    const payload: GuestUpdatePlanPayload = {
      relativePath: loaded.relativePath,
      generatedAt: generatedAt.toISOString(),
      restartRequired: diff.restartRequired,
    };
    const row = await this.repos.plans.create({
      id: plan.id,
      operation: plan.operation,
      hostId: input.hostId,
      vmid: input.vmid,
      status: 'ready',
      summary: plan.summary,
      changesJson: JSON.stringify(plan.changes),
      warningsJson: JSON.stringify(plan.warnings),
      destructive: plan.destructive,
      stateFingerprint: plan.stateFingerprint,
      confirmationText: plan.confirmationText ?? null,
      payloadJson: JSON.stringify(payload),
      createdBy: input.createdBy ?? null,
      createdAt: new Date(plan.createdAt),
    });
    return rowToPublicPlan(row);
  }

  public async get(planId: string): Promise<PublicPlan | null> {
    const row = await this.reconcileApplying(
      await this.repos.plans.get(planId),
    );
    return row ? rowToPublicPlan(row) : null;
  }

  public async list(
    filter: {
      readonly hostId?: string | undefined;
      readonly statuses?: readonly PlanRow['status'][] | undefined;
      readonly limit?: number | undefined;
    } = {},
  ): Promise<readonly PublicPlan[]> {
    const rows = await this.repos.plans.list(filter);
    const reconciled = await Promise.all(
      rows.map((row) => this.reconcileApplying(row)),
    );
    return reconciled
      .filter((row): row is PlanRow => row !== null)
      .map(rowToPublicPlan);
  }

  public async queueApply(
    planId: string,
    input: QueuePlanApplyInput,
  ): Promise<QueuePlanApplyResult> {
    let row = await this.reconcileApplying(await this.repos.plans.get(planId));
    if (!row) throw new PlanNotFoundError(planId);
    if (row.status === 'applied') {
      throw new PlanStateError(`Plan '${planId}' has already been applied`);
    }
    if (row.status === 'applying') {
      throw new PlanStateError(`Plan '${planId}' is already applying`);
    }
    if (row.status === 'stale') {
      throw new PlanStateError(
        `Plan '${planId}' is stale and must be recreated`,
      );
    }
    if (row.destructive && input.confirmation !== row.confirmationText) {
      throw new PlanConfirmationError(row.confirmationText ?? '');
    }
    const operationPayload = parseJson<GuestImportPlanPayload>(
      row.payloadJson,
      {
        overwrite: false,
        generatedAt: row.createdAt.toISOString(),
        requiresAdmin: false,
      },
    );
    const requiresAdmin =
      row.operation === 'guest.create' || operationPayload.requiresAdmin;
    if (requiresAdmin && input.user.role !== 'admin') {
      throw new PlanAdminRequiredError(
        row.operation === 'guest.create'
          ? 'Creating guests is restricted to administrators'
          : undefined,
      );
    }

    try {
      const current = await this.currentState(row);
      assertPlanFresh(rowToMutationPlan(row), current);
    } catch (error) {
      if (error instanceof StalePlanError) {
        await this.repos.plans.updateStatus(planId, 'stale', {
          error: error.message,
        });
      }
      throw error;
    }

    const dryRun = input.dryRun ?? false;
    const jobId = randomUUID();
    if (!dryRun) {
      const claimed = await this.repos.plans.claimApply(planId, {
        jobId,
        approvedBy: input.user.id,
      });
      if (!claimed) {
        throw new PlanStateError(
          `Plan '${planId}' could not be claimed for apply`,
        );
      }
      row = claimed;
    }

    try {
      const job = await this.queue.enqueue({
        id: jobId,
        hostId: row.hostId,
        ...(row.vmid !== null ? { vmid: row.vmid } : {}),
        type: 'plan.apply',
        // A power request must preempt queued low-priority host work (D-28).
        ...(row.operation === 'guest.power'
          ? { priority: 'power' as const }
          : {}),
        payload: { planId, dryRun },
        triggeredBy: input.user.id,
      });
      return { plan: rowToPublicPlan(row), job };
    } catch (error) {
      if (!dryRun) {
        await this.repos.plans.updateStatus(planId, 'failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  public async executeJob(context: JobExecutionContext): Promise<void> {
    const payload = context.payload as {
      readonly planId?: unknown;
      readonly dryRun?: unknown;
    };
    if (
      typeof payload?.planId !== 'string' ||
      typeof payload.dryRun !== 'boolean'
    ) {
      throw new PlanStateError('Plan apply job payload is invalid');
    }
    const row = await this.repos.plans.get(payload.planId);
    if (!row) throw new PlanNotFoundError(payload.planId);
    if (
      !payload.dryRun &&
      (row.status !== 'applying' || row.lastJobId !== context.job.id)
    ) {
      throw new PlanStateError(
        `Plan '${row.id}' is not claimed by job '${context.job.id}'`,
      );
    }

    const plan = rowToMutationPlan(row);
    if (row.operation !== 'guest.import') {
      await this.executeGuestOperationJob(row, plan, payload.dryRun, context);
      return;
    }
    const operationPayload = parseJson<GuestImportPlanPayload>(
      row.payloadJson,
      {
        overwrite: false,
        generatedAt: row.createdAt.toISOString(),
        requiresAdmin: false,
      },
    );
    try {
      await runJournaledSteps({
        operationId: context.job.id,
        input: undefined,
        transport: unavailableTransport,
        logger: createJobStepLogger(context.log),
        dryRun: payload.dryRun,
        signal: context.signal,
        journal: new DatabaseStepJournal(this.repos),
        steps: [
          {
            name: 'apply planned guest import',
            check: async () => {
              const snapshot = await this.buildGuestImportSnapshot(
                row.hostId,
                row.vmid!,
                new Date(operationPayload.generatedAt),
              );
              const desiredHash = await hashContent(
                snapshot.importPlan.yamlContent,
              );
              if (
                snapshot.target.exists &&
                snapshot.target.hash === desiredHash
              ) {
                return {
                  status: 'satisfied',
                  detail: { relativeFile: snapshot.importPlan.relativeFile },
                };
              }
              assertPlanFresh(plan, snapshot.currentState);
              return { status: 'required' };
            },
            apply: async () => {
              const snapshot = await this.buildGuestImportSnapshot(
                row.hostId,
                row.vmid!,
                new Date(operationPayload.generatedAt),
              );
              const result = await executeMutationPlan({
                plan,
                dryRun: false,
                signal: context.signal,
                getCurrentState: async () => snapshot.currentState,
                executeChange: async (change) =>
                  this.executeGuestImportChange(
                    change,
                    snapshot,
                    operationPayload,
                  ),
              });
              return result;
            },
            verify: async () => {
              const snapshot = await this.buildGuestImportSnapshot(
                row.hostId,
                row.vmid!,
                new Date(operationPayload.generatedAt),
              );
              const desiredHash = await hashContent(
                snapshot.importPlan.yamlContent,
              );
              if (snapshot.target.hash !== desiredHash) {
                throw new PlanStateError(
                  `Plan '${row.id}' verification found unexpected target content (expected ${desiredHash}, got ${snapshot.target.hash ?? '<missing>'})`,
                );
              }
              return {
                relativeFile: snapshot.importPlan.relativeFile,
                hash: desiredHash,
              };
            },
            rollbackHint:
              'Inspect the generated deployment.yaml and restore the previous Git version if needed.',
          },
        ],
      });

      if (!payload.dryRun) {
        const appliedAt = new Date();
        await this.repos.plans.updateStatus(row.id, 'applied', {
          appliedAt,
          error: null,
        });
        await this.repos.auditLogs.append({
          userId: row.approvedBy,
          hostId: row.hostId,
          vmid: row.vmid,
          action: 'plan.apply',
          reason: 'orphan_action',
          jobId: context.job.id,
          diff: sanitizeAuditPayload({
            planId: row.id,
            changes: plan.changes,
          }),
          metadata: { operation: row.operation },
        });
      }
    } catch (error) {
      const stale =
        error instanceof StalePlanError ||
        (error instanceof Error && error.cause instanceof StalePlanError);
      if (stale) {
        await this.repos.plans.updateStatus(row.id, 'stale', {
          error: error instanceof Error ? error.message : String(error),
        });
      } else if (!payload.dryRun) {
        await this.repos.plans.updateStatus(row.id, 'failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  private async executeGuestImportChange(
    change: PlanChange,
    snapshot: GuestImportSnapshot,
    payload: GuestImportPlanPayload,
  ): Promise<{ readonly status: 'applied'; readonly detail: unknown }> {
    if (change.id !== 'deployment-file') {
      throw new PlanStateError(
        `Guest import plan contains unsupported change '${change.id}'`,
      );
    }
    const result = await applyGuestImport({
      plan: snapshot.importPlan,
      overwrite: payload.overwrite,
      expectedHash: snapshot.target.hash ?? '',
    });
    if (!result.success) {
      throw new PlanStateError(
        `Guest import could not apply: ${result.reason ?? 'unknown error'}`,
      );
    }
    return {
      status: 'applied',
      detail: { relativeFile: result.relativeFile },
    };
  }

  private requireLifecycle(): GuestLifecycleService {
    if (!this.lifecycle) {
      throw new PlanStateError(
        'Guest lifecycle operations are not configured for this server',
      );
    }
    return this.lifecycle;
  }

  private requireConnections(): Pick<
    ConnectionManager,
    'getRouter' | 'secretManager'
  > {
    if (!this.connections) {
      throw new PlanStateError(
        'Guest provisioning is not configured for this server',
      );
    }
    return this.connections;
  }

  private async executeGuestOperationJob(
    row: PlanRow,
    plan: MutationPlan,
    dryRun: boolean,
    context: JobExecutionContext,
  ): Promise<void> {
    if (row.vmid === null) {
      throw new PlanStateError(
        `Plan operation '${row.operation}' requires a guest VMID`,
      );
    }
    const guestVmid = row.vmid;
    let steps: readonly JournaledStep<undefined>[];
    let transport: Transport = unavailableTransport;
    if (row.operation === 'guest.create') {
      const snapshot = await this.buildGuestCreateSnapshot(
        row.hostId,
        row.vmid,
      );
      assertPlanFresh(plan, createCurrentState(row.vmid, snapshot));
      if (!snapshot.deployment) {
        throw new PlanStateError(
          `No deployment YAML is configured for guest ${row.vmid} on host '${row.hostId}'`,
        );
      }
      if (snapshot.deployment.type !== 'lxc') {
        throw new PlanStateError(
          `Guest ${row.vmid} is a VM; LXC creation only supports deployments with type 'lxc'`,
        );
      }
      if (snapshot.occupiedBy) {
        throw new PlanStateError(collisionMessage(row.hostId, row.vmid));
      }
      steps = createLxcProvisionSteps(snapshot.deployment, {
        hostId: row.hostId,
      });
      transport = await this.requireConnections().getRouter(row.hostId);
    } else if (row.operation === 'guest.update') {
      const lifecycle = this.requireLifecycle();
      const loaded = await this.loadResolvedGuestDeployment(
        row.hostId,
        guestVmid,
      );
      if (!loaded) {
        throw new PlanStateError(
          `No deployment YAML is configured for guest ${guestVmid} on host '${row.hostId}'`,
        );
      }
      if (loaded.deployment.type !== 'lxc') {
        throw new PlanStateError(
          `Guest ${guestVmid} is a VM; LXC config updates only support deployments with type 'lxc'`,
        );
      }
      const snapshot = await lifecycle.requireSnapshot(row.hostId, guestVmid);
      if (snapshot.deployment.type !== 'lxc') {
        throw new PlanStateError(
          `Guest ${row.hostId}/${guestVmid} is not an LXC container`,
        );
      }
      assertPlanFresh(
        plan,
        lxcUpdateState(loaded.deployment, snapshot.deployment),
      );
      const payload = parseJson<GuestUpdatePlanPayload>(row.payloadJson, {
        relativePath: loaded.relativePath,
        generatedAt: row.createdAt.toISOString(),
        restartRequired: false,
      });
      await lifecycle.verifyForMutation(row.hostId, guestVmid, {
        operation: 'guest.update',
        allowProtected: !plan.destructive,
      });
      steps = createLxcUpdateSteps(loaded.deployment, {
        hostId: row.hostId,
        restartRequired: payload.restartRequired,
        restart: async () => {
          const current = await lifecycle.requireSnapshot(
            row.hostId,
            guestVmid,
          );
          if (current.status !== 'running') {
            await context.log(
              'system',
              `Guest ${row.hostId}/${guestVmid} is stopped; the configuration will apply on its next start.`,
            );
            return;
          }
          await lifecycle.executePower(row.hostId, guestVmid, 'shutdown', {
            signal: context.signal,
            log: (message) => context.log('system', message),
          });
          await lifecycle.waitForPowerState(row.hostId, guestVmid, 'shutdown', {
            signal: context.signal,
          });
          await lifecycle.executePower(row.hostId, guestVmid, 'start', {
            signal: context.signal,
            log: (message) => context.log('system', message),
          });
          await lifecycle.waitForPowerState(row.hostId, guestVmid, 'start', {
            signal: context.signal,
          });
        },
      });
      transport = await this.requireConnections().getRouter(row.hostId);
    } else if (row.operation === 'guest.power') {
      const lifecycle = this.requireLifecycle();
      const payload = parseJson<GuestPowerPlanPayload>(row.payloadJson, {
        action: 'start',
        targetStatus: 'running',
        generatedAt: row.createdAt.toISOString(),
      });
      if (
        payload.action !== 'start' &&
        payload.action !== 'stop' &&
        payload.action !== 'shutdown' &&
        payload.action !== 'reboot'
      ) {
        throw new PlanStateError(
          `Guest power plan contains unknown action '${String(payload.action)}'`,
        );
      }
      const action = payload.action;
      steps = this.buildPowerSteps(row, plan, action, lifecycle, (message) =>
        context.log('system', message),
      );
    } else if (row.operation === 'guest.stamp') {
      steps = this.buildStampSteps(row, plan, this.requireLifecycle());
    } else {
      throw new PlanStateError(
        `Plan operation '${row.operation}' is not supported`,
      );
    }

    try {
      await runJournaledSteps({
        operationId: context.job.id,
        input: undefined,
        transport,
        logger: createJobStepLogger(context.log),
        dryRun,
        signal: context.signal,
        journal: new DatabaseStepJournal(this.repos),
        steps,
      });

      if (!dryRun) {
        await this.repos.plans.updateStatus(row.id, 'applied', {
          appliedAt: new Date(),
          error: null,
        });
        await this.repos.auditLogs.append({
          userId: row.approvedBy,
          hostId: row.hostId,
          vmid: row.vmid,
          action: 'plan.apply',
          reason: 'manual',
          jobId: context.job.id,
          diff: sanitizeAuditPayload({
            planId: row.id,
            changes: plan.changes,
          }),
          metadata: { operation: row.operation },
        });
      }
    } catch (error) {
      const stale =
        error instanceof StalePlanError ||
        (error instanceof Error && error.cause instanceof StalePlanError);
      if (stale) {
        await this.repos.plans.updateStatus(row.id, 'stale', {
          error: error instanceof Error ? error.message : String(error),
        });
      } else if (!dryRun) {
        await this.repos.plans.updateStatus(row.id, 'failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  private buildPowerSteps(
    row: PlanRow,
    plan: MutationPlan,
    action: GuestPowerAction,
    lifecycle: GuestLifecycleService,
    log: (message: string) => Promise<void>,
  ): readonly JournaledStep<undefined>[] {
    const hostId = row.hostId;
    const vmid = row.vmid!;
    const targetStatus =
      action === 'start' || action === 'reboot' ? 'running' : 'stopped';
    return [
      {
        name: `power ${action} guest ${vmid}`,
        check: async () => {
          const snapshot = await lifecycle.requireSnapshot(hostId, vmid);
          assertPlanFresh(plan, lifecycleState(snapshot));
          if (action !== 'reboot' && snapshot.status === targetStatus) {
            return {
              status: 'satisfied',
              detail: { status: snapshot.status },
            };
          }
          return { status: 'required', detail: { status: snapshot.status } };
        },
        apply: async () => {
          await lifecycle.verifyForMutation(hostId, vmid, {
            operation: `guest.power.${action}`,
            runIdentityChecks: false,
          });
          const result = await lifecycle.executePower(hostId, vmid, action, {
            log,
          });
          return {
            status: 'applied',
            detail: {
              source: result.source,
              ...(result.upid ? { upid: result.upid } : {}),
            },
          };
        },
        verify: async () => lifecycle.waitForPowerState(hostId, vmid, action),
        rollbackHint: `Use the opposite power action for ${hostId}/${vmid} if the guest state is unexpected.`,
      },
    ];
  }

  private buildStampSteps(
    row: PlanRow,
    plan: MutationPlan,
    lifecycle: GuestLifecycleService,
  ): readonly JournaledStep<undefined>[] {
    const hostId = row.hostId;
    const vmid = row.vmid!;
    const expectedUuid = managedGuestUuid(hostId, vmid);
    return [
      {
        name: `stamp guest ${vmid} as managed`,
        check: async () => {
          const snapshot = await lifecycle.requireSnapshot(hostId, vmid);
          assertPlanFresh(plan, lifecycleState(snapshot));
          const fields = stampFieldsOf(snapshot);
          if (
            isManagedGuestTag(fields.tags) &&
            parseManagedGuestUuid(fields.description) === expectedUuid
          ) {
            return {
              status: 'satisfied',
              detail: { uuid: expectedUuid },
            };
          }
          return { status: 'required' };
        },
        apply: async () => {
          await lifecycle.verifyForMutation(hostId, vmid, {
            operation: 'guest.stamp',
            runIdentityChecks: false,
            requireManaged: false,
          });
          await lifecycle.stampGuest(hostId, vmid);
          return { status: 'applied', detail: { uuid: expectedUuid } };
        },
        verify: async () => {
          const snapshot = await lifecycle.requireSnapshot(hostId, vmid);
          const fields = stampFieldsOf(snapshot);
          if (
            !isManagedGuestTag(fields.tags) ||
            parseManagedGuestUuid(fields.description) !== expectedUuid
          ) {
            throw new PlanStateError(
              `Guest ${hostId}/${vmid} does not carry the expected management stamp after apply`,
            );
          }
          return { uuid: expectedUuid };
        },
        rollbackHint:
          'Recreate the guest metadata from its reviewed YAML if the stamp is wrong.',
      },
    ];
  }

  private async currentState(row: PlanRow): Promise<unknown> {
    if (row.operation === 'guest.import') {
      if (row.vmid === null) {
        throw new PlanStateError(
          `Plan operation '${row.operation}' requires a guest VMID`,
        );
      }
      return (await this.buildGuestImportSnapshot(row.hostId, row.vmid))
        .currentState;
    }
    if (row.operation === 'guest.create') {
      if (row.vmid === null) {
        throw new PlanStateError(
          `Plan operation '${row.operation}' requires a guest VMID`,
        );
      }
      const snapshot = await this.buildGuestCreateSnapshot(
        row.hostId,
        row.vmid,
      );
      return createCurrentState(row.vmid, snapshot);
    }
    if (row.operation === 'guest.update') {
      if (row.vmid === null) {
        throw new PlanStateError(
          `Plan operation '${row.operation}' requires a guest VMID`,
        );
      }
      const lifecycle = this.requireLifecycle();
      const loaded = await this.loadResolvedGuestDeployment(
        row.hostId,
        row.vmid,
      );
      const snapshot = await lifecycle.requireSnapshot(row.hostId, row.vmid);
      return {
        desired: loaded?.deployment ?? null,
        live: snapshot.deployment,
      };
    }
    if (row.operation === 'guest.power' || row.operation === 'guest.stamp') {
      if (row.vmid === null) {
        throw new PlanStateError(
          `Plan operation '${row.operation}' requires a guest VMID`,
        );
      }
      const lifecycle = this.requireLifecycle();
      const snapshot = await lifecycle.requireSnapshot(row.hostId, row.vmid);
      return lifecycleState(snapshot);
    }
    throw new PlanStateError(
      `Plan operation '${row.operation}' is not supported`,
    );
  }

  private async reconcileApplying(
    row: PlanRow | null,
  ): Promise<PlanRow | null> {
    if (!row || row.status !== 'applying' || row.lastJobId === null) return row;
    const job = await this.repos.jobs.get(row.lastJobId);
    if (!job) {
      await this.repos.plans.updateStatus(row.id, 'failed', {
        error: `Apply job '${row.lastJobId}' no longer exists`,
      });
      return this.repos.plans.get(row.id);
    }
    if (
      job.status === 'failed' ||
      job.status === 'cancelled' ||
      job.status === 'interrupted'
    ) {
      await this.repos.plans.updateStatus(row.id, 'failed', {
        error: job.error ?? `Apply job ended with status '${job.status}'`,
      });
      return this.repos.plans.get(row.id);
    }
    return row;
  }

  private async buildGuestCreateSnapshot(
    hostId: string,
    vmid: number,
  ): Promise<GuestCreateSnapshot> {
    const loaded = await this.loadResolvedGuestDeployment(hostId, vmid);
    if (!loaded) {
      return { deployment: null, relativePath: null, occupiedBy: null };
    }
    const occupiedBy = await this.vmidOccupied(hostId, vmid);
    return { ...loaded, occupiedBy };
  }

  private async loadResolvedGuestDeployment(
    hostId: string,
    vmid: number,
  ): Promise<{
    readonly deployment: GuestDeployment;
    readonly relativePath: string;
  } | null> {
    const loaded = await loadGuestDeployment(
      this.hostRegistry.dataDir,
      hostId,
      vmid,
    );
    if (!loaded) return null;
    const host = this.hostRegistry.getRawHost?.(hostId);
    const result = await resolveConfigTags<GuestDeployment>(loaded.deployment, {
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
    });
    if (!result.report.isFullyResolved) {
      const reasons = [
        ...result.report.errors.map(
          (entry) => `'!${entry.tag} ${entry.raw}': ${entry.error}`,
        ),
        ...result.report.unresolved.map(
          (entry) => `'!${entry.tag} ${entry.raw}': ${entry.reason}`,
        ),
        ...result.report.locked.map(
          (entry) => `'!${entry.tag} ${entry.raw}': ${entry.reason}`,
        ),
      ];
      throw new PlanStateError(
        `Deployment '${loaded.relativePath}' could not be resolved: ${reasons.join('; ')}`,
      );
    }
    return {
      deployment: result.data,
      relativePath: loaded.relativePath,
    };
  }

  private async vmidOccupied(
    hostId: string,
    vmid: number,
  ): Promise<'lxc' | 'vm' | null> {
    const router = await this.requireConnections().getRouter(hostId);
    for (const [type, path] of [
      ['lxc', `/etc/pve/local/lxc/${vmid}.conf`],
      ['vm', `/etc/pve/local/qemu-server/${vmid}.conf`],
    ] as const) {
      try {
        const result = await router.exec(['test', '-f', path], {
          timeoutMs: 5_000,
        });
        if (result.exitCode === 0) return type;
      } catch (error) {
        throw new PlanStateError(
          `Unable to check whether VMID ${vmid} is free on host '${hostId}': ${toErrorMessage(error)}`,
        );
      }
    }
    return null;
  }

  private async buildGuestImportSnapshot(
    hostId: string,
    vmid: number,
    generatedAt?: Date,
  ): Promise<GuestImportSnapshot> {
    const [liveDetail, defaults] = await Promise.all([
      this.inventoryService.getGuestLiveConfig(hostId, vmid),
      this.loadDefaults(hostId),
    ]);
    const importPlan = await planGuestImport({
      dataDir: this.hostRegistry.dataDir,
      hostId,
      guest: liveDetail.canonicalConfig,
      defaults,
      generatedAt,
    });
    const target = await this.readTarget(importPlan);
    const afterDocument = loadYamlDocument(importPlan.yamlContent);
    return {
      importPlan,
      target,
      after: afterDocument.toJSON(),
      currentState: {
        live: liveDetail.canonicalConfig,
        defaults: defaults ?? null,
        target: { exists: target.exists, hash: target.hash },
      },
    };
  }

  private async loadDefaults(
    hostId: string,
  ): Promise<DeploymentDefaultsFile | undefined> {
    try {
      const content = await readFile(
        join(
          this.hostRegistry.dataDir,
          'hosts',
          hostId,
          'default-deployment.yaml',
        ),
        'utf8',
      );
      return deploymentDefaultsFileSchema.parse(
        loadYamlDocument(content).toJSON(),
      );
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
  }

  private async readTarget(plan: GuestImportPlan): Promise<TargetState> {
    try {
      const raw = await readFile(plan.fullPath, 'utf8');
      const document = loadYamlDocument(raw);
      const parsed = parseGuestConfigurationForEditor(raw, {
        vmid: plan.vmid,
        name: plan.name,
        relativePath: plan.relativeFile,
      });
      return {
        exists: true,
        hash: await hashContent(raw),
        value:
          document.errors.length === 0
            ? document.toJSON()
            : { invalidYaml: true },
        requiresAdmin: parsed.adminOnly.length > 0,
      };
    } catch (error) {
      if (isMissingFile(error)) {
        return {
          exists: false,
          hash: null,
          value: null,
          requiresAdmin: false,
        };
      }
      throw error;
    }
  }
}

export const planServiceInternals = { unavailableTransport };

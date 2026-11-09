import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  applyGuestImport,
  assertPlanFresh,
  createMutationPlan,
  deploymentDefaultsFileSchema,
  executeMutationPlan,
  hashContent,
  loadYamlDocument,
  planGuestImport,
  runJournaledSteps,
  sanitizeAuditPayload,
  StalePlanError,
  type DeploymentDefaultsFile,
  type GuestImportPlan,
  type MutationPlan,
  type PlanChange,
  type Transport,
} from '@hacm/core';
import type { DatabaseRepositories } from '../db/repositories/types.js';
import type { PlanRow } from '../db/schema.js';
import type { HostRegistry } from '../hosts/registry.js';
import type { LiveInventoryService } from '../inventory/service.js';
import { parseGuestConfigurationForEditor } from '../inventory/configuration.js';
import {
  DatabaseStepJournal,
  createJobStepLogger,
} from '../jobs/step-journal.js';
import type { DurableJobQueue } from '../jobs/queue.js';
import type { JobExecutionContext } from '../jobs/types.js';
import {
  PlanConfirmationError,
  PlanAdminRequiredError,
  PlanNotFoundError,
  PlanOverwriteRequiredError,
  PlanStateError,
  type CreateGuestImportPlanInput,
  type GuestImportPlanPayload,
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
    private readonly hostRegistry: Pick<HostRegistry, 'dataDir'>,
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
    if (operationPayload.requiresAdmin && input.user.role !== 'admin') {
      throw new PlanAdminRequiredError();
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

  private async currentState(row: PlanRow): Promise<unknown> {
    if (row.operation !== 'guest.import' || row.vmid === null) {
      throw new PlanStateError(
        `Plan operation '${row.operation}' is not supported`,
      );
    }
    return (await this.buildGuestImportSnapshot(row.hostId, row.vmid))
      .currentState;
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

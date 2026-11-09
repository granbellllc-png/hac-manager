import type { DatabaseRepositories } from '../db/repositories/types.js';
import type { DriftService } from '../drift/service.js';
import type { HostRegistry } from '../hosts/registry.js';
import type { HostDetail } from '../hosts/types.js';
import type { LiveInventoryService } from '../inventory/service.js';
import type { DurableJobQueue } from '../jobs/queue.js';
import type { JobExecutionContext } from '../jobs/types.js';
import {
  cronMatches,
  parseCronExpression,
  type ParsedCronExpression,
} from './cron.js';

interface BackoffState {
  readonly failures: number;
  readonly nextAttemptAt: string;
}

export interface DriftSchedulerOptions {
  readonly pollIntervalMs?: number | undefined;
  readonly baseBackoffMs?: number | undefined;
  readonly maxBackoffMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
  readonly onError?: ((error: unknown) => void) | undefined;
  readonly driftService?: Pick<DriftService, 'checkHost'> | undefined;
}

type SchedulerHostRegistry = Pick<
  HostRegistry,
  'listHosts' | 'getRawHost' | 'getHost'
>;

type SchedulerInventory = Pick<LiveInventoryService, 'getHostInventory'>;

function minuteSlot(date: Date): string {
  return date.toISOString().slice(0, 16);
}

function parseBackoff(value: string | null): BackoffState | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      typeof parsed['failures'] === 'number' &&
      typeof parsed['nextAttemptAt'] === 'string'
    ) {
      return {
        failures: parsed['failures'],
        nextAttemptAt: parsed['nextAttemptAt'],
      };
    }
  } catch {
    return null;
  }
  return null;
}

export class ScheduledDriftUnavailableError extends Error {
  public constructor(
    public readonly hostId: string,
    message: string,
  ) {
    super(message);
    this.name = 'ScheduledDriftUnavailableError';
  }
}

export class DriftScheduler {
  private readonly pollIntervalMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly now: () => Date;
  private readonly onError: (error: unknown) => void;
  private readonly driftService: Pick<DriftService, 'checkHost'> | undefined;
  private readonly cronCache = new Map<string, ParsedCronExpression>();
  private timer?: ReturnType<typeof setInterval> | undefined;
  private ticking = false;

  public constructor(
    private readonly repos: DatabaseRepositories,
    private readonly queue: DurableJobQueue,
    private readonly hostRegistry: SchedulerHostRegistry,
    private readonly inventoryService: SchedulerInventory,
    options: DriftSchedulerOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 30_000;
    this.baseBackoffMs = options.baseBackoffMs ?? 60_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60 * 60_000;
    this.now = options.now ?? (() => new Date());
    this.onError = options.onError ?? (() => undefined);
    this.driftService = options.driftService;
  }

  public registerQueueHandler(): void {
    this.queue.registerHandler('drift.check', (context) =>
      this.executeJob(context),
    );
  }

  public start(): void {
    if (this.timer) return;
    void this.tick().catch(this.onError);
    this.timer = setInterval(() => {
      void this.tick().catch(this.onError);
    }, this.pollIntervalMs);
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  public async tick(at = this.now()): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      const hosts = await this.hostRegistry.listHosts();
      let enqueued = 0;
      for (const host of hosts) {
        const raw = this.hostRegistry.getRawHost(host.id);
        const schedule = raw?.drift_schedule;
        if (!schedule?.enabled) continue;
        let expression = this.cronCache.get(schedule.cron);
        try {
          if (!expression) {
            expression = parseCronExpression(schedule.cron);
            this.cronCache.set(schedule.cron, expression);
          }
        } catch (error) {
          this.onError(error);
          continue;
        }
        if (!cronMatches(expression, at)) continue;

        const slot = minuteSlot(at);
        const lastSlotKey = this.lastSlotKey(host.id);
        if ((await this.repos.settings.get(lastSlotKey)) === slot) continue;
        const backoff = parseBackoff(
          await this.repos.settings.get(this.backoffKey(host.id)),
        );
        if (
          backoff &&
          new Date(backoff.nextAttemptAt).getTime() > at.getTime()
        ) {
          continue;
        }
        const active = await this.repos.jobs.list({
          hostId: host.id,
          statuses: ['queued', 'running', 'waiting_input'],
        });
        if (active.some((job) => job.type === 'drift.check')) {
          await this.repos.settings.set(lastSlotKey, slot);
          continue;
        }

        await this.repos.settings.set(lastSlotKey, slot);
        try {
          await this.queue.enqueue({
            hostId: host.id,
            type: 'drift.check',
            reason: 'schedule',
            priority: 'low',
            payload: { scheduledFor: `${slot}:00.000Z` },
          });
          enqueued++;
        } catch (error) {
          await this.repos.settings.delete(lastSlotKey);
          throw error;
        }
      }
      return enqueued;
    } finally {
      this.ticking = false;
    }
  }

  public async executeJob(context: JobExecutionContext): Promise<void> {
    const hostId = context.job.hostId;
    let outcome: 'completed' | 'unavailable' = 'completed';
    let failure: unknown;
    try {
      const host = (await this.hostRegistry.getHost(hostId)) as
        HostDetail | undefined;
      if (!host) {
        throw new ScheduledDriftUnavailableError(
          hostId,
          `Host '${hostId}' is no longer configured`,
        );
      }
      if (host.runtime.vault.status === 'locked') {
        throw new ScheduledDriftUnavailableError(
          hostId,
          `Vault is locked for host '${hostId}'`,
        );
      }
      const inventory = await this.inventoryService.getHostInventory(
        hostId,
        true,
      );
      if (inventory.status === 'error' || inventory.status === 'offline') {
        throw new ScheduledDriftUnavailableError(
          hostId,
          inventory.error ?? `Host '${hostId}' is unavailable`,
        );
      }
      await context.log(
        'system',
        `Scheduled drift check refreshed ${inventory.guests.length} guest${inventory.guests.length === 1 ? '' : 's'}`,
      );
      if (this.driftService) {
        const drift = await this.driftService.checkHost(hostId);
        await context.log(
          'system',
          `Compared ${drift.checked} configured guest${drift.checked === 1 ? '' : 's'}`,
        );
        for (const failure of drift.failures) {
          await context.log(
            'stderr',
            `Drift check failed for guest ${failure.vmid}: ${failure.message}`,
          );
        }
      }
      await this.clearBackoff(hostId);
    } catch (error) {
      outcome = 'unavailable';
      failure = error;
      const state = await this.recordFailure(hostId);
      await context.log(
        'stderr',
        `Scheduled drift check unavailable; retry after ${state.nextAttemptAt}`,
      );
      throw error;
    } finally {
      await this.repos.auditLogs.append({
        hostId,
        action: 'drift.check',
        reason: context.job.reason,
        jobId: context.job.id,
        diff: { status: outcome },
        metadata: {
          ...(failure
            ? {
                error:
                  failure instanceof Error ? failure.message : String(failure),
              }
            : {}),
        },
      });
    }
  }

  private async recordFailure(hostId: string): Promise<BackoffState> {
    const existing = parseBackoff(
      await this.repos.settings.get(this.backoffKey(hostId)),
    );
    const failures = (existing?.failures ?? 0) + 1;
    const delay = Math.min(
      this.baseBackoffMs * 2 ** Math.min(failures - 1, 20),
      this.maxBackoffMs,
    );
    const state = {
      failures,
      nextAttemptAt: new Date(this.now().getTime() + delay).toISOString(),
    };
    await this.repos.settings.set(
      this.backoffKey(hostId),
      JSON.stringify(state),
    );
    return state;
  }

  private async clearBackoff(hostId: string): Promise<void> {
    await this.repos.settings.delete(this.backoffKey(hostId));
  }

  private lastSlotKey(hostId: string): string {
    return `scheduler.drift.${hostId}.last_slot`;
  }

  private backoffKey(hostId: string): string {
    return `scheduler.drift.${hostId}.backoff`;
  }
}

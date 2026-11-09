import {
  assessGuestIdentity,
  globalSecretRedactor,
  isManagedGuestTag,
  liveIdentityFromDeployment,
  managedGuestUuid,
  parseManagedGuestUuid,
  stampManagedIdentity,
  type GuestDeployment,
  type GuestIdentityAssessment,
} from '@hacm/core';
import type { HostConnectionRouter } from '../router/router.js';
import type { ConnectionManager } from '../router/manager.js';
import type { HostRegistry } from '../hosts/registry.js';
import type { LiveInventoryService } from '../inventory/service.js';
import type { LiveGuestSummary } from '../inventory/types.js';
import { loadGuestDeployment } from './configuration.js';
import {
  GuestIdentityCheckError,
  GuestIdentityError,
  GuestNotFoundError,
  GuestProtectionEnabledError,
  GuestStateUnavailableError,
  GuestStoppedIdentityError,
  ProtectedGuestError,
  type GuestIdentityCheckResult,
  type GuestIdentityReport,
  type GuestLifecycleProtectedConfig,
  type GuestSnapshot,
} from './types.js';

export type GuestPowerAction = 'start' | 'stop' | 'shutdown' | 'reboot';

export interface GuestLifecycleOptions {
  readonly inventory: Pick<
    LiveInventoryService,
    'getHostInventory' | 'getGuestLiveConfig' | 'invalidate'
  >;
  readonly connections: Pick<ConnectionManager, 'getRouter'>;
  readonly hostRegistry: Pick<HostRegistry, 'dataDir'>;
  readonly protectedGuest?: GuestLifecycleProtectedConfig | undefined;
}

export interface GuardedGuestOptions {
  readonly operation: string;
  readonly runIdentityChecks?: boolean | undefined;
  readonly requireManaged?: boolean | undefined;
  /**
   * Permit a non-destructive operation on a guest whose YAML enables
   * `protection`. Callers must still block destructive changes themselves.
   */
  readonly allowProtected?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
}

interface GuestIdentityState {
  readonly snapshot: GuestSnapshot;
  readonly expected: GuestDeployment | null;
  readonly assessment: GuestIdentityAssessment;
}

function routeFor(snapshot: GuestSnapshot): string {
  return `${snapshot.hostId}/${snapshot.vmid}`;
}

function sanitizeOutput(value: string): string {
  return globalSecretRedactor.redactLine(value.trim()).slice(0, 500);
}

export class GuestLifecycleService {
  private readonly inventory: GuestLifecycleOptions['inventory'];
  private readonly connections: GuestLifecycleOptions['connections'];
  private readonly hostRegistry: GuestLifecycleOptions['hostRegistry'];
  private readonly protectedGuest: GuestLifecycleProtectedConfig;

  public constructor(options: GuestLifecycleOptions) {
    this.inventory = options.inventory;
    this.connections = options.connections;
    this.hostRegistry = options.hostRegistry;
    this.protectedGuest = options.protectedGuest ?? {};
  }

  /** True when this host/guest pair is the instance hosting HAC Manager itself. */
  public isSelfManaged(hostId: string, vmid: number): boolean {
    if (this.protectedGuest.vmid !== vmid) return false;
    return (
      this.protectedGuest.hostId === undefined ||
      this.protectedGuest.hostId === hostId
    );
  }

  public assertNotSelfManaged(hostId: string, vmid: number): void {
    if (this.isSelfManaged(hostId, vmid)) {
      throw new ProtectedGuestError(hostId, vmid);
    }
  }

  public async getSnapshot(
    hostId: string,
    vmid: number,
    typeHint?: GuestDeployment['type'],
    forceRefresh = false,
  ): Promise<GuestSnapshot | null> {
    const inventory = await this.inventory.getHostInventory(
      hostId,
      forceRefresh,
    );
    if (inventory.status === 'error' && inventory.guests.length === 0) {
      throw new GuestStateUnavailableError(
        hostId,
        inventory.error ?? 'inventory is unavailable',
      );
    }

    const summary = inventory.guests.find((guest) => guest.vmid === vmid);
    if (!summary) {
      const foundType = await this.probeConfigFile(hostId, vmid, typeHint);
      if (!foundType) return null;
      const detail = await this.inventory.getGuestLiveConfig(
        hostId,
        vmid,
        foundType,
      );
      const fallbackSummary: LiveGuestSummary = {
        hostId,
        vmid,
        name: detail.canonicalConfig.name,
        type: foundType,
        status: 'unknown',
        node: 'localhost',
      };
      return {
        hostId,
        vmid,
        type: foundType,
        summary: fallbackSummary,
        deployment: detail.canonicalConfig,
        status: 'unknown',
      };
    }

    const type = typeHint ?? summary.type;
    const detail = await this.inventory.getGuestLiveConfig(hostId, vmid, type);
    return {
      hostId,
      vmid,
      type,
      summary,
      deployment: detail.canonicalConfig,
      status: summary.status,
    };
  }

  public async requireSnapshot(
    hostId: string,
    vmid: number,
    typeHint?: GuestDeployment['type'],
  ): Promise<GuestSnapshot> {
    const snapshot = await this.getSnapshot(hostId, vmid, typeHint);
    if (!snapshot) throw new GuestNotFoundError(hostId, vmid);
    return snapshot;
  }

  public async getIdentityReport(
    hostId: string,
    vmid: number,
    options: {
      readonly runIdentityChecks?: boolean | undefined;
      readonly signal?: AbortSignal | undefined;
    } = {},
  ): Promise<GuestIdentityReport | null> {
    const expected = await loadGuestDeployment(
      this.hostRegistry.dataDir,
      hostId,
      vmid,
    );
    if (!expected) return null;
    const snapshot = await this.getSnapshot(
      hostId,
      vmid,
      expected.deployment.type,
    );
    if (!snapshot) {
      const expectedUuid = managedGuestUuid(hostId, vmid);
      return {
        hostId,
        vmid,
        name: expected.deployment.name,
        type: expected.deployment.type,
        status: 'missing',
        managed: false,
        expectedUuid,
        messages: [`Guest ${vmid} does not exist on host '${hostId}'.`],
        checks: [],
      };
    }

    const state = this.assess(snapshot, expected.deployment);
    const checks =
      options.runIdentityChecks === false
        ? []
        : await this.runIdentityChecks(
            snapshot,
            expected.deployment.identity_checks ?? [],
            options.signal,
          );
    return this.toReport(state, checks);
  }

  /**
   * Run the anti-collision guard before any mutating operation. A mismatch,
   * missing stamp, failed identity check or stopped guest halts the caller.
   */
  public async verifyForMutation(
    hostId: string,
    vmid: number,
    options: GuardedGuestOptions,
  ): Promise<GuestSnapshot> {
    this.assertNotSelfManaged(hostId, vmid);
    const snapshot = await this.requireSnapshot(hostId, vmid);
    const expected = await loadGuestDeployment(
      this.hostRegistry.dataDir,
      hostId,
      vmid,
    );
    const expectedDeployment = expected?.deployment ?? null;
    const state = this.assess(
      snapshot,
      expectedDeployment ?? snapshot.deployment,
      expectedDeployment === null,
    );

    if (!expectedDeployment) return snapshot;

    // `requireManaged: false` is the explicit adoption path (stamp). It only
    // relaxes the missing stamp/tag, never a reused VMID, wrong name or wrong
    // guest type.
    const allowUnmanaged =
      options.requireManaged === false &&
      state.assessment.status === 'unmanaged';
    if (!state.assessment.ok && !allowUnmanaged) {
      throw new GuestIdentityError(this.toReport(state, []));
    }

    if (
      !allowUnmanaged &&
      expectedDeployment.protection &&
      options.operation !== 'guest.power.start' &&
      options.operation !== 'guest.stamp' &&
      !options.allowProtected
    ) {
      throw new GuestProtectionEnabledError(hostId, vmid);
    }

    const checks = expectedDeployment.identity_checks ?? [];
    if (options.runIdentityChecks !== false && checks.length > 0) {
      if (snapshot.status !== 'running') {
        throw new GuestStoppedIdentityError(hostId, vmid);
      }
      const results = await this.runIdentityChecks(
        snapshot,
        checks,
        options.signal,
      );
      const failed = results.find((result) => !result.ok);
      if (failed) throw new GuestIdentityCheckError(failed);
    }
    return snapshot;
  }

  /** Add the management tag and UUID stamp to an existing guest. */
  public async stampGuest(
    hostId: string,
    vmid: number,
    options: {
      readonly dryRun?: boolean | undefined;
      readonly signal?: AbortSignal | undefined;
    } = {},
  ): Promise<{
    readonly tags: readonly string[];
    readonly description: string;
    readonly changed: boolean;
  }> {
    this.assertNotSelfManaged(hostId, vmid);
    const snapshot = await this.requireSnapshot(hostId, vmid);
    const stamped = stampManagedIdentity(
      {
        tags: snapshot.deployment.tags,
        description: this.descriptionOf(snapshot.deployment),
      },
      managedGuestUuid(hostId, vmid),
    );
    if (!stamped.changed || options.dryRun) return stamped;

    const tool = snapshot.type === 'lxc' ? 'pct' : 'qm';
    const result = await this.exec(
      hostId,
      [
        tool,
        'set',
        String(vmid),
        '--tags',
        stamped.tags.join(';'),
        '--description',
        stamped.description,
      ],
      options.signal,
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to stamp guest ${routeFor(snapshot)}: ${sanitizeOutput(result.stderr) || `exit code ${result.exitCode}`}`,
      );
    }
    this.inventory.invalidate(hostId);
    return stamped;
  }

  public async executePower(
    hostId: string,
    vmid: number,
    action: GuestPowerAction,
    options: {
      readonly signal?: AbortSignal | undefined;
      readonly log?: ((message: string) => Promise<void>) | undefined;
    } = {},
  ): Promise<{ readonly upid?: string | undefined; readonly source: string }> {
    this.assertNotSelfManaged(hostId, vmid);
    const snapshot = await this.requireSnapshot(hostId, vmid);
    const router = await this.connections.getRouter(hostId);
    const result = await router.powerAction(vmid, snapshot.type, action);
    await options.log?.(
      `Proxmox accepted '${action}' for guest ${routeFor(snapshot)} via ${result.source}${result.upid ? ` (UPID ${result.upid})` : ''}`,
    );
    if (result.upid) {
      const client = router.client;
      if (client) {
        await client.waitForTask(result.upid, {
          signal: options.signal,
          timeoutMs: 300_000,
        });
      }
    }
    this.inventory.invalidate(hostId);
    return result;
  }

  public async verifyPowerState(
    hostId: string,
    vmid: number,
    action: GuestPowerAction,
  ): Promise<{ readonly status: string; readonly expected: string }> {
    const snapshot = await this.getSnapshot(hostId, vmid, undefined, true);
    if (!snapshot) throw new GuestNotFoundError(hostId, vmid);
    const expected =
      action === 'stop' || action === 'shutdown' ? 'stopped' : 'running';
    if (snapshot.status !== expected) {
      throw new Error(
        `Guest ${routeFor(snapshot)} is '${snapshot.status}' after '${action}', expected '${expected}'`,
      );
    }
    return { status: snapshot.status, expected };
  }

  /** Wait for a power transition to settle, because both channels are async. */
  public async waitForPowerState(
    hostId: string,
    vmid: number,
    action: GuestPowerAction,
    options: {
      readonly timeoutMs?: number | undefined;
      readonly intervalMs?: number | undefined;
      readonly signal?: AbortSignal | undefined;
    } = {},
  ): Promise<{ readonly status: string; readonly expected: string }> {
    const timeoutMs = options.timeoutMs ?? 60_000;
    const intervalMs = options.intervalMs ?? 500;
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() <= deadline) {
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new Error('Power verification aborted');
      }
      try {
        return await this.verifyPowerState(hostId, vmid, action);
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(
          `Guest ${hostId}/${vmid} did not reach its target power state`,
        );
  }

  public async runIdentityChecksForReport(
    hostId: string,
    vmid: number,
    checks: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly GuestIdentityCheckResult[]> {
    const snapshot = await this.requireSnapshot(hostId, vmid);
    return this.runIdentityChecks(snapshot, checks, signal);
  }

  private assess(
    snapshot: GuestSnapshot,
    expected: GuestDeployment,
    unmanaged = false,
  ): GuestIdentityState {
    const assessment = assessGuestIdentity(
      {
        hostId: snapshot.hostId,
        vmid: snapshot.vmid,
        name: expected.name,
        type: expected.type,
      },
      liveIdentityFromDeployment(snapshot.deployment, {
        exists: true,
        status: snapshot.status,
      }),
    );
    if (unmanaged) {
      return {
        snapshot,
        expected: null,
        assessment: {
          ...assessment,
          status: 'verified',
          ok: true,
          messages: [],
        },
      };
    }
    return { snapshot, expected, assessment };
  }

  private toReport(
    state: GuestIdentityState,
    checks: readonly GuestIdentityCheckResult[],
  ): GuestIdentityReport {
    const { assessment, snapshot } = state;
    return {
      hostId: snapshot.hostId,
      vmid: snapshot.vmid,
      name: snapshot.deployment.name,
      type: snapshot.type,
      status: assessment.status,
      managed:
        assessment.status === 'verified' &&
        isManagedGuestTag(snapshot.deployment.tags),
      expectedUuid: assessment.expectedUuid,
      ...(assessment.actualUuid ? { actualUuid: assessment.actualUuid } : {}),
      messages: assessment.messages,
      checks,
    };
  }

  private async runIdentityChecks(
    snapshot: GuestSnapshot,
    checks: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly GuestIdentityCheckResult[]> {
    if (checks.length === 0) return [];
    const results: GuestIdentityCheckResult[] = [];
    for (const check of checks) {
      const result =
        snapshot.type === 'lxc'
          ? await this.exec(
              snapshot.hostId,
              ['pct', 'exec', String(snapshot.vmid), '--', '/bin/sh', '-s'],
              signal,
              `${check}\n`,
            )
          : await this.exec(
              snapshot.hostId,
              [
                'qm',
                'guest',
                'exec',
                String(snapshot.vmid),
                '--',
                '/bin/sh',
                '-c',
                check,
              ],
              signal,
            );
      const ok = result.exitCode === 0 && !result.timedOut;
      results.push({
        check,
        ok,
        exitCode: result.exitCode,
        stderr: sanitizeOutput(result.stderr),
      });
      if (!ok) break;
    }
    return results;
  }

  private async probeConfigFile(
    hostId: string,
    vmid: number,
    typeHint?: GuestDeployment['type'],
  ): Promise<GuestDeployment['type'] | null> {
    let router: HostConnectionRouter;
    try {
      router = await this.connections.getRouter(hostId);
    } catch {
      return null;
    }
    const candidates: GuestDeployment['type'][] = typeHint
      ? [typeHint]
      : ['lxc', 'vm'];
    for (const type of candidates) {
      const path =
        type === 'lxc'
          ? `/etc/pve/local/lxc/${vmid}.conf`
          : `/etc/pve/local/qemu-server/${vmid}.conf`;
      try {
        const result = await router.exec(['test', '-f', path], {
          timeoutMs: 5_000,
        });
        if (result.exitCode === 0) return type;
      } catch {
        // No SSH/config channel; rely on inventory only.
        return null;
      }
    }
    return null;
  }

  private descriptionOf(deployment: GuestDeployment): string | undefined {
    const description = deployment.extra?.['description'];
    return typeof description === 'string' ? description : undefined;
  }

  private async exec(
    hostId: string,
    argv: readonly string[],
    signal?: AbortSignal,
    stdin?: string,
  ) {
    const router = await this.connections.getRouter(hostId);
    return router.exec(argv, {
      ...(stdin !== undefined ? { stdin } : {}),
      ...(signal ? { signal } : {}),
      timeoutMs: 60_000,
    });
  }
}

export function managementStampOf(description: string | undefined): {
  readonly uuid: string | undefined;
  readonly tag: string;
} {
  return {
    uuid: parseManagedGuestUuid(description),
    tag: 'hacm-managed',
  };
}

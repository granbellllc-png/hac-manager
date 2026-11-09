import { formatSizeGb } from '../codec/options.js';
import { parseLxcProxmoxConfig } from '../codec/lxc.js';
import { MANAGED_GUEST_TAG } from '../guest/identity.js';
import type { PlanChange } from '../plans/types.js';
import type { GuestDeployment } from '../schema/deployment.js';
import type { JournaledStep } from '../steps/types.js';
import { Secret } from '../tags/secret.js';
import type { Transport } from '../transport/types.js';
import { formatLxcFeatures, formatLxcNetwork } from './lxc.js';

type Lxc = Extract<GuestDeployment, { type: 'lxc' }>;

/** A rejected update, for example a disk shrink or a pending configuration. */
export class LxcUpdateError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'LxcUpdateError';
  }
}

export interface LxcUpdatePlan {
  readonly summary: string;
  readonly changes: readonly PlanChange[];
  readonly warnings: readonly string[];
  /** `pct` commands to run for this diff, in a safe order. */
  readonly commands: readonly (readonly string[])[];
  readonly restartRequired: boolean;
  readonly destructive: boolean;
  readonly blocked: boolean;
  readonly blockReason?: string | undefined;
}

export interface LxcUpdateStepOptions {
  readonly hostId: string;
  readonly restartRequired: boolean;
  /** Stop/start the guest after applying restart-required changes. */
  readonly restart?: (() => Promise<void>) | undefined;
}

function scalar(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (value instanceof Secret) return value.unwrap();
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return String(value);
  }
  throw new LxcUpdateError(
    `${field} still contains an unresolved tag; evaluate the deployment before updating.`,
  );
}

function numberValue(value: unknown, field: string): number | undefined {
  const text = scalar(value, field);
  if (text === undefined || text === '') return undefined;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) {
    throw new LxcUpdateError(`${field} must be a finite number`);
  }
  return parsed;
}

function boolValue(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  throw new LxcUpdateError(
    `${field} still contains an unresolved tag; evaluate the deployment before updating.`,
  );
}

function managedTags(tags: readonly string[] | undefined): string[] {
  const set = new Set(tags ?? []);
  set.add(MANAGED_GUEST_TAG);
  return [...set];
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

function networkMap(guest: Lxc): Map<number, string> {
  const map = new Map<number, string>();
  for (const network of guest.network) {
    map.set(network.index, formatLxcNetwork(network));
  }
  return map;
}

/** Keys currently waiting in the `[PENDING]` section of `pct config`. */
export function lxcPendingKeys(guest: GuestDeployment): readonly string[] {
  const pending = guest.extra?.['_pending'];
  if (!pending || typeof pending !== 'object' || Array.isArray(pending)) {
    return [];
  }
  return Object.keys(pending as Record<string, unknown>).sort();
}

function blockedPlan(
  desired: Lxc,
  reason: string,
  warnings: readonly string[] = [],
): LxcUpdatePlan {
  return {
    summary: `Update LXC ${desired.id} (${desired.name})`,
    changes: [],
    warnings,
    commands: [],
    restartRequired: false,
    destructive: false,
    blocked: true,
    blockReason: reason,
  };
}

function blockedError(plan: LxcUpdatePlan): LxcUpdateError {
  // A blocked plan always carries a reason; the cast avoids an unreachable
  // fallback branch that would otherwise never be covered.
  return new LxcUpdateError(plan.blockReason as string);
}

/**
 * Pure YAML-versus-live diff for an LXC container. Disks are additive only and
 * a shrink blocks the whole plan. Removed NICs and lifting protection are
 * destructive and therefore require typed confirmation.
 */
export function planLxcUpdate(desired: Lxc, live: Lxc): LxcUpdatePlan {
  const summary = `Update LXC ${desired.id} (${desired.name})`;
  const pending = lxcPendingKeys(live);
  if (pending.length > 0) {
    return blockedPlan(
      desired,
      `LXC ${desired.id} has pending configuration changes (${pending.join(', ')}). Apply or revert them before updating.`,
    );
  }

  const changes: PlanChange[] = [];
  const warnings: string[] = [];
  const commands: string[][] = [];
  let restartRequired = false;
  let destructive = false;
  let blockReason: string | undefined = undefined;
  const vmid = String(desired.id);

  const push = (
    change: PlanChange,
    command: readonly string[],
    restart: boolean,
  ): void => {
    changes.push(change);
    commands.push([...command]);
    if (restart) restartRequired = true;
  };

  const desiredCpu = numberValue(desired.cpu, 'cpu');
  const liveCpu = numberValue(live.cpu, 'cpu');
  if (desiredCpu !== undefined && desiredCpu !== liveCpu) {
    push(
      {
        id: 'cpu',
        action: 'update',
        summary: `Set CPU cores to ${desiredCpu}`,
        before: liveCpu,
        after: desiredCpu,
      },
      ['pct', 'set', vmid, '--cores', String(desiredCpu)],
      true,
    );
  }

  const desiredRam = numberValue(desired.ram, 'ram');
  const liveRam = numberValue(live.ram, 'ram');
  if (desiredRam !== undefined && desiredRam !== liveRam) {
    push(
      {
        id: 'ram',
        action: 'update',
        summary: `Set memory to ${desiredRam} MB`,
        before: liveRam,
        after: desiredRam,
      },
      ['pct', 'set', vmid, '--memory', String(desiredRam)],
      true,
    );
  }

  const desiredSwap = numberValue(desired.swap, 'swap');
  const liveSwap = numberValue(live.swap, 'swap');
  if (desiredSwap !== undefined && desiredSwap !== liveSwap) {
    push(
      {
        id: 'swap',
        action: 'update',
        summary: `Set swap to ${desiredSwap} MB`,
        before: liveSwap,
        after: desiredSwap,
      },
      ['pct', 'set', vmid, '--swap', String(desiredSwap)],
      true,
    );
  } else if (desiredSwap === undefined && liveSwap !== undefined) {
    warnings.push(
      'swap is not declared in YAML; the live swap value is left unchanged.',
    );
  }

  const desiredTags = managedTags(desired.tags);
  const liveTags = [...(live.tags ?? [])];
  if (!sameStringSet(desiredTags, liveTags)) {
    push(
      {
        id: 'tags',
        action: 'update',
        summary: 'Update guest tags',
        before: liveTags,
        after: desiredTags,
      },
      ['pct', 'set', vmid, '--tags', desiredTags.join(';')],
      false,
    );
  }

  const desiredFeatures = formatLxcFeatures(desired.features);
  const liveFeatures = formatLxcFeatures(live.features);
  if (desired.features !== undefined) {
    if (desiredFeatures !== liveFeatures) {
      push(
        {
          id: 'features',
          action: 'update',
          summary: 'Update LXC features',
          before: liveFeatures ?? null,
          after: desiredFeatures ?? null,
        },
        desiredFeatures
          ? ['pct', 'set', vmid, '--features', desiredFeatures]
          : ['pct', 'set', vmid, '--delete', 'features'],
        true,
      );
    }
  } else if (liveFeatures !== undefined) {
    warnings.push(
      'features are not declared in YAML; the live feature flags are left unchanged.',
    );
  }

  const desiredProtection = boolValue(desired.protection, 'protection');
  const liveProtection = boolValue(live.protection, 'protection') ?? false;
  if (desiredProtection !== undefined && desiredProtection !== liveProtection) {
    if (!desiredProtection) destructive = true;
    push(
      {
        id: 'protection',
        action: 'update',
        summary: desiredProtection
          ? 'Enable guest protection'
          : 'Disable guest protection',
        before: liveProtection,
        after: desiredProtection,
        destructive: !desiredProtection,
      },
      ['pct', 'set', vmid, '--protection', desiredProtection ? '1' : '0'],
      false,
    );
  } else if (desiredProtection === undefined && liveProtection) {
    warnings.push(
      'protection is enabled on the live guest but not declared in YAML; it is left enabled.',
    );
  }

  const desiredNets = networkMap(desired);
  const liveNets = networkMap(live);
  const netIndexes = [
    ...new Set([...desiredNets.keys(), ...liveNets.keys()]),
  ].sort((a, b) => a - b);
  for (const index of netIndexes) {
    const after = desiredNets.get(index);
    const before = liveNets.get(index);
    if (after === undefined && before !== undefined) {
      destructive = true;
      push(
        {
          id: `net${index}`,
          action: 'delete',
          summary: `Remove network interface net${index}`,
          before,
          after: null,
          destructive: true,
        },
        ['pct', 'set', vmid, '--delete', `net${index}`],
        true,
      );
    } else if (after !== undefined && before === undefined) {
      push(
        {
          id: `net${index}`,
          action: 'create',
          summary: `Add network interface net${index}`,
          before: null,
          after,
        },
        ['pct', 'set', vmid, `--net${index}`, after],
        true,
      );
    } else if (
      after !== undefined &&
      before !== undefined &&
      after !== before
    ) {
      push(
        {
          id: `net${index}`,
          action: 'update',
          summary: `Update network interface net${index}`,
          before,
          after,
        },
        ['pct', 'set', vmid, `--net${index}`, after],
        true,
      );
    }
  }

  const desiredRootfs = desired.disks.find((disk) => disk.name === 'rootfs');
  const liveRootfs = live.disks.find((disk) => disk.name === 'rootfs');
  if (desiredRootfs) {
    const desiredSize = numberValue(
      desiredRootfs.size_gb,
      'disks.rootfs.size_gb',
    );
    const liveSize = liveRootfs
      ? numberValue(liveRootfs.size_gb, 'disks.rootfs.size_gb')
      : undefined;
    if (desiredSize !== undefined && liveSize !== undefined) {
      if (desiredSize < liveSize) {
        blockReason = `Refusing to shrink rootfs of LXC ${desired.id} from ${liveSize} GB to ${desiredSize} GB. Disks only grow.`;
      } else if (desiredSize > liveSize) {
        push(
          {
            id: 'disk-rootfs',
            action: 'update',
            summary: `Grow rootfs from ${liveSize} GB to ${desiredSize} GB`,
            before: liveSize,
            after: desiredSize,
          },
          ['pct', 'resize', vmid, 'rootfs', formatSizeGb(desiredSize)],
          false,
        );
      }
    } else if (liveSize === undefined) {
      warnings.push(
        'The live rootfs disk is not visible; its size was not changed.',
      );
    }
    const desiredStorage = scalar(
      desiredRootfs.storage,
      'disks.rootfs.storage',
    );
    const liveStorage = liveRootfs
      ? scalar(liveRootfs.storage, 'disks.rootfs.storage')
      : undefined;
    if (
      desiredStorage !== undefined &&
      liveStorage !== undefined &&
      desiredStorage !== liveStorage
    ) {
      warnings.push(
        `rootfs storage differs (YAML '${desiredStorage}', live '${liveStorage}'); storage moves are not performed by an update.`,
      );
    }
  } else if (liveRootfs) {
    warnings.push(
      'The live guest has a rootfs disk that is not declared in YAML; it is left unchanged.',
    );
  }
  for (const disk of desired.disks) {
    if (disk.name !== 'rootfs') {
      warnings.push(
        `Disk '${disk.name}' is not managed by an LXC config update; it was left unchanged.`,
      );
    }
  }

  if (blockReason !== undefined) {
    return {
      summary,
      changes,
      warnings,
      commands,
      restartRequired,
      destructive,
      blocked: true,
      blockReason,
    };
  }

  if (restartRequired) {
    warnings.push(
      'A running guest is restarted after the update so the new configuration takes effect.',
    );
  }

  return {
    summary,
    changes,
    warnings,
    commands,
    restartRequired,
    destructive,
    blocked: false,
  };
}

/** State used to fingerprint an update plan against YAML and live config. */
export function lxcUpdateState(desired: Lxc, live: Lxc): unknown {
  return { desired, live };
}

async function readLiveConfig(
  transport: Transport,
  vmid: number,
): Promise<Lxc> {
  const result = await transport.exec(['pct', 'config', String(vmid)], {
    timeoutMs: 10_000,
  });
  if (result.exitCode !== 0) {
    throw new LxcUpdateError(
      `Failed to read the configuration of LXC ${vmid}: ${
        result.stderr.trim() || `exit code ${result.exitCode}`
      }`,
    );
  }
  const parsed = parseLxcProxmoxConfig(result.stdout, vmid);
  return parsed as Lxc;
}

function describeRemaining(plan: LxcUpdatePlan): string {
  return plan.changes.map((change) => change.id).join(', ');
}

/**
 * Journaled steps that re-read the live config, apply only the reviewed diff
 * and verify the result. A running guest is restarted when any change needs it.
 */
export function createLxcUpdateSteps(
  desired: Lxc,
  options: LxcUpdateStepOptions,
): readonly JournaledStep<undefined>[] {
  const vmid = desired.id;
  const hostId = options.hostId;
  const steps: JournaledStep<undefined>[] = [
    {
      name: `update configuration of LXC ${vmid}`,
      check: async ({ transport }) => {
        const live = await readLiveConfig(transport, vmid);
        const plan = planLxcUpdate(desired, live);
        if (plan.blocked) throw blockedError(plan);
        if (plan.changes.length === 0) {
          return { status: 'satisfied', detail: { changes: [] } };
        }
        return {
          status: 'required',
          detail: { changes: plan.changes.map((change) => change.id) },
        };
      },
      apply: async ({ transport, logger }) => {
        const live = await readLiveConfig(transport, vmid);
        const plan = planLxcUpdate(desired, live);
        if (plan.blocked) throw blockedError(plan);
        for (const argv of plan.commands) {
          const result = await transport.exec(argv, {
            timeoutMs: 120_000,
            onOutput: (stream, line) => {
              void logger.info(`${argv.join(' ')} ${stream}: ${line}`);
            },
          });
          if (result.exitCode !== 0) {
            throw new LxcUpdateError(
              `Command '${argv.join(' ')}' failed for LXC ${vmid}: ${
                result.stderr.trim() || `exit code ${result.exitCode}`
              }`,
            );
          }
        }
        return { status: 'applied', commands: plan.commands };
      },
      verify: async ({ transport }) => {
        const live = await readLiveConfig(transport, vmid);
        const pending = lxcPendingKeys(live);
        if (options.restartRequired && pending.length > 0) {
          return { pending };
        }
        const plan = planLxcUpdate(desired, live);
        if (plan.blocked) throw blockedError(plan);
        if (plan.changes.length === 0) {
          return { changes: 0, pending };
        }
        throw new LxcUpdateError(
          `LXC ${vmid} still differs after update: ${describeRemaining(plan)}`,
        );
      },
      rollbackHint: `Review the previous values in the plan and run 'pct set ${vmid} ...' manually on ${hostId} to restore them.`,
    },
  ];

  if (options.restartRequired) {
    steps.push({
      name: `restart LXC ${vmid} to apply pending configuration`,
      check: async ({ transport }) => {
        const live = await readLiveConfig(transport, vmid);
        if (lxcPendingKeys(live).length === 0) {
          const plan = planLxcUpdate(desired, live);
          if (plan.changes.length === 0) {
            return { status: 'satisfied', detail: { pending: 0 } };
          }
        }
        if (!options.restart) {
          throw new LxcUpdateError(
            `LXC ${vmid} requires a restart but no restart hook is configured`,
          );
        }
        return { status: 'required' };
      },
      apply: async () => {
        await options.restart!();
        return { restarted: true };
      },
      verify: async ({ transport }) => {
        const live = await readLiveConfig(transport, vmid);
        const pending = lxcPendingKeys(live);
        if (pending.length > 0) {
          throw new LxcUpdateError(
            `LXC ${vmid} still has pending configuration after restart: ${pending.join(', ')}`,
          );
        }
        const plan = planLxcUpdate(desired, live);
        if (plan.blocked) throw blockedError(plan);
        if (plan.changes.length > 0) {
          throw new LxcUpdateError(
            `LXC ${vmid} still differs after restart: ${describeRemaining(plan)}`,
          );
        }
        return { pending: 0, changes: 0 };
      },
      rollbackHint: `Start LXC ${vmid} on ${hostId} again if the restart left it stopped, then inspect 'pct config ${vmid}'.`,
    });
  }

  return steps;
}

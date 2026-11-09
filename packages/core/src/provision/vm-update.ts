import { formatOptionString, formatSizeGb } from '../codec/options.js';
import { parseVmProxmoxConfig } from '../codec/vm.js';
import { MANAGED_GUEST_TAG } from '../guest/identity.js';
import type { PlanChange } from '../plans/types.js';
import type { GuestDeployment } from '../schema/deployment.js';
import type { JournaledStep } from '../steps/types.js';
import { Secret } from '../tags/secret.js';
import type { Transport } from '../transport/types.js';
import { formatVmIpConfig, formatVmNetwork } from './vm.js';

type Vm = Extract<GuestDeployment, { type: 'vm' }>;
type VmDisk = Vm['disks'][number];

/** A rejected VM update, for example a disk shrink or a pending change. */
export class VmUpdateError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'VmUpdateError';
  }
}

export interface VmUpdatePlan {
  readonly summary: string;
  readonly changes: readonly PlanChange[];
  readonly warnings: readonly string[];
  /** `qm` commands to run for this diff, in a safe order. */
  readonly commands: readonly (readonly string[])[];
  readonly restartRequired: boolean;
  readonly destructive: boolean;
  readonly blocked: boolean;
  readonly blockReason?: string | undefined;
}

export interface VmUpdateStepOptions {
  readonly hostId: string;
  readonly restartRequired: boolean;
  /** Stop/start the VM after applying restart-required changes. */
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
  throw new VmUpdateError(
    `${field} still contains an unresolved tag; evaluate the deployment before updating.`,
  );
}

function numberValue(value: unknown, field: string): number | undefined {
  const text = scalar(value, field);
  if (text === undefined || text === '') return undefined;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) {
    throw new VmUpdateError(`${field} must be a finite number`);
  }
  return parsed;
}

function boolValue(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value instanceof Secret) {
    throw new VmUpdateError(
      `${field} resolved to a secret; a boolean was expected.`,
    );
  }
  if (typeof value === 'boolean') return value;
  throw new VmUpdateError(
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

/** Keys currently waiting in the `[PENDING]` section of `qm config`. */
export function vmPendingKeys(guest: GuestDeployment): readonly string[] {
  const pending = guest.extra?.['_pending'];
  if (!pending || typeof pending !== 'object' || Array.isArray(pending)) {
    return [];
  }
  return Object.keys(pending as Record<string, unknown>).sort();
}

function blockedPlan(
  desired: Vm,
  reason: string,
  warnings: readonly string[] = [],
): VmUpdatePlan {
  return {
    summary: `Update VM ${desired.id} (${desired.name})`,
    changes: [],
    warnings,
    commands: [],
    restartRequired: false,
    destructive: false,
    blocked: true,
    blockReason: reason,
  };
}

function blockedError(plan: VmUpdatePlan): VmUpdateError {
  // A blocked plan always carries a reason.
  return new VmUpdateError(plan.blockReason as string);
}

function formatDiskSpec(disk: VmDisk): string {
  const storage = scalar(disk.storage, 'disks.storage') ?? 'local-lvm';
  const size = numberValue(disk.size_gb, 'disks.size_gb') ?? 1;
  const opts: Record<string, string> = {};
  for (const [key, value] of Object.entries(disk.extra ?? {})) {
    if (key === 'volume' || key === 'size') continue;
    const text = scalar(value, `disks.${disk.name}.${key}`);
    if (text !== undefined && text !== '') opts[key] = text;
  }
  return formatOptionString(`${storage}:${formatSizeGb(size)}`, opts);
}

function diskOptionKeys(disk: VmDisk): string {
  return formatOptionString(
    undefined,
    Object.fromEntries(
      Object.entries(disk.extra ?? {})
        .filter(([key]) => key !== 'volume' && key !== 'size')
        .map(([key, value]) => [key, String(value)]),
    ),
  );
}

function networkMaps(
  guest: Vm,
): Map<number, { readonly net: string; readonly ipconfig?: string }> {
  const map = new Map<
    number,
    { readonly net: string; readonly ipconfig?: string }
  >();
  for (const network of guest.network) {
    map.set(network.index, {
      net: formatVmNetwork(network),
      ...(formatVmIpConfig(network)
        ? { ipconfig: formatVmIpConfig(network)! }
        : {}),
    });
  }
  return map;
}

function networkCommandCommands(
  vmid: string,
  index: number,
  desired: { readonly net: string; readonly ipconfig?: string } | undefined,
  live: { readonly net: string; readonly ipconfig?: string } | undefined,
): string[][] {
  const commands: string[][] = [];
  if (desired && !live) {
    commands.push(['qm', 'set', vmid, `--net${index}`, desired.net]);
    if (desired.ipconfig) {
      commands.push([
        'qm',
        'set',
        vmid,
        `--ipconfig${index}`,
        desired.ipconfig,
      ]);
    }
    return commands;
  }
  if (!desired && live) {
    commands.push(['qm', 'set', vmid, '--delete', `net${index}`]);
    if (live.ipconfig) {
      commands.push(['qm', 'set', vmid, '--delete', `ipconfig${index}`]);
    }
    return commands;
  }
  if (desired && live && desired.net !== live.net) {
    commands.push(['qm', 'set', vmid, `--net${index}`, desired.net]);
  }
  if (desired && live) {
    if (desired.ipconfig && desired.ipconfig !== live.ipconfig) {
      commands.push([
        'qm',
        'set',
        vmid,
        `--ipconfig${index}`,
        desired.ipconfig,
      ]);
    } else if (!desired.ipconfig && live.ipconfig) {
      commands.push(['qm', 'set', vmid, '--delete', `ipconfig${index}`]);
    }
  }
  return commands;
}

/**
 * Pure YAML-versus-live diff for a QEMU VM. Disks are additive only and a
 * shrink blocks the whole plan. Removing a NIC or lifting protection is
 * destructive and requires typed confirmation. `[PENDING]` keys block the
 * update until the guest is rebooted or the pending values are reverted.
 */
export function planVmUpdate(desired: Vm, live: Vm): VmUpdatePlan {
  const summary = `Update VM ${desired.id} (${desired.name})`;
  const pending = vmPendingKeys(live);
  if (pending.length > 0) {
    return blockedPlan(
      desired,
      `VM ${desired.id} has pending configuration changes (${pending.join(', ')}). Apply or revert them before updating.`,
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
      ['qm', 'set', vmid, '--cores', String(desiredCpu)],
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
      ['qm', 'set', vmid, '--memory', String(desiredRam)],
      true,
    );
  }

  if (desired.bios !== undefined && desired.bios !== live.bios) {
    push(
      {
        id: 'bios',
        action: 'update',
        summary: `Set BIOS to ${desired.bios}`,
        before: live.bios,
        after: desired.bios,
      },
      ['qm', 'set', vmid, '--bios', desired.bios],
      true,
    );
  }

  if (desired.machine !== undefined && desired.machine !== live.machine) {
    push(
      {
        id: 'machine',
        action: 'update',
        summary: `Set machine type to ${desired.machine}`,
        before: live.machine ?? null,
        after: desired.machine,
      },
      ['qm', 'set', vmid, '--machine', desired.machine],
      true,
    );
  }

  if (desired.guest_agent !== undefined) {
    const liveAgent = live.guest_agent === true;
    if (desired.guest_agent !== liveAgent) {
      push(
        {
          id: 'guest_agent',
          action: 'update',
          summary: desired.guest_agent
            ? 'Enable the QEMU guest agent'
            : 'Disable the QEMU guest agent',
          before: liveAgent,
          after: desired.guest_agent,
        },
        ['qm', 'set', vmid, '--agent', desired.guest_agent ? 'enabled=1' : '0'],
        true,
      );
    }
  }

  const storage =
    scalar(desired.disks[0]?.storage, 'disks[0].storage') ?? 'local-lvm';
  if (desired.efi_disk === true && live.efi_disk !== true) {
    push(
      {
        id: 'efi_disk',
        action: 'create',
        summary: 'Add the EFI disk',
        before: false,
        after: true,
      },
      [
        'qm',
        'set',
        vmid,
        '--efidisk0',
        `${storage}:1,efitype=4m,pre-enrolled-keys=1`,
      ],
      true,
    );
  } else if (live.efi_disk === true && desired.efi_disk !== true) {
    warnings.push(
      'The live VM has an EFI disk that is not declared in YAML; it is left unchanged.',
    );
  }

  if (desired.tpm === true && live.tpm !== true) {
    push(
      {
        id: 'tpm',
        action: 'create',
        summary: 'Add the TPM state disk',
        before: false,
        after: true,
      },
      ['qm', 'set', vmid, '--tpmstate0', `${storage}:1,version=v2.0`],
      true,
    );
  } else if (live.tpm === true && desired.tpm !== true) {
    warnings.push(
      'The live VM has a TPM state disk that is not declared in YAML; it is left unchanged.',
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
      ['qm', 'set', vmid, '--tags', desiredTags.join(';')],
      false,
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
      ['qm', 'set', vmid, '--protection', desiredProtection ? '1' : '0'],
      false,
    );
  } else if (desiredProtection === undefined && liveProtection) {
    warnings.push(
      'protection is enabled on the live guest but not declared in YAML; it is left enabled.',
    );
  }

  if (desired.cloud_init) {
    const desiredUser = scalar(desired.cloud_init.user, 'cloud_init.user');
    const liveUser = scalar(live.cloud_init?.user, 'cloud_init.user');
    if (desiredUser !== undefined && desiredUser !== liveUser) {
      push(
        {
          id: 'cloud_init_user',
          action: 'update',
          summary: `Set cloud-init user to ${desiredUser}`,
          before: liveUser ?? null,
          after: desiredUser,
        },
        ['qm', 'set', vmid, '--ciuser', desiredUser],
        true,
      );
    }
    const desiredKeys = (desired.cloud_init.ssh_keys ?? []).map(
      (key) => scalar(key, 'cloud_init.ssh_keys') ?? '',
    );
    const liveKeys = (live.cloud_init?.ssh_keys ?? []).map(
      (key) => scalar(key, 'cloud_init.ssh_keys') ?? '',
    );
    if (
      desiredKeys.length > 0 &&
      desiredKeys.join('\n') !== liveKeys.join('\n')
    ) {
      push(
        {
          id: 'cloud_init_ssh_keys',
          action: 'update',
          summary: 'Update cloud-init SSH keys',
          before: liveKeys,
          after: desiredKeys,
        },
        [
          'qm',
          'set',
          vmid,
          '--sshkeys',
          encodeURIComponent(desiredKeys.join('\n')),
        ],
        true,
      );
    }
    if (desired.cloud_init.password !== undefined) {
      warnings.push(
        'cloud-init passwords are not compared by an update; set --cipassword manually if it changed.',
      );
    }
  }

  const desiredNets = networkMaps(desired);
  const liveNets = networkMaps(live);
  const netIndexes = [
    ...new Set([...desiredNets.keys(), ...liveNets.keys()]),
  ].sort((a, b) => a - b);
  for (const index of netIndexes) {
    const after = desiredNets.get(index);
    const before = liveNets.get(index);
    const commandsForNet = networkCommandCommands(vmid, index, after, before);
    if (commandsForNet.length === 0) continue;
    if (!after && before) {
      destructive = true;
      restartRequired = true;
      changes.push({
        id: `net${index}`,
        action: 'delete',
        summary: `Remove network interface net${index}`,
        before: before.net,
        after: null,
        destructive: true,
      });
      commands.push(...commandsForNet);
    } else if (after && !before) {
      restartRequired = true;
      changes.push({
        id: `net${index}`,
        action: 'create',
        summary: `Add network interface net${index}`,
        before: null,
        after: after.net,
      });
      commands.push(...commandsForNet);
    } else if (after && before) {
      restartRequired = true;
      changes.push({
        id: `net${index}`,
        action: 'update',
        summary: `Update network interface net${index}`,
        before: before.net,
        after: after.net,
      });
      commands.push(...commandsForNet);
    }
  }

  const desiredDisks = new Map(desired.disks.map((disk) => [disk.name, disk]));
  const liveDisks = new Map(live.disks.map((disk) => [disk.name, disk]));
  for (const disk of desired.disks) {
    const liveDisk = liveDisks.get(disk.name);
    const desiredSize = numberValue(disk.size_gb, `disks.${disk.name}.size_gb`);
    if (!liveDisk) {
      push(
        {
          id: `disk-${disk.name}`,
          action: 'create',
          summary: `Add disk ${disk.name}`,
          before: null,
          after: desiredSize ?? null,
        },
        ['qm', 'set', vmid, `--${disk.name}`, formatDiskSpec(disk)],
        false,
      );
      continue;
    }
    const liveSize = numberValue(
      liveDisk.size_gb,
      `disks.${disk.name}.size_gb`,
    );
    if (desiredSize !== undefined && liveSize !== undefined) {
      if (desiredSize < liveSize) {
        blockReason = `Refusing to shrink ${disk.name} of VM ${desired.id} from ${liveSize} GB to ${desiredSize} GB. Disks only grow.`;
      } else if (desiredSize > liveSize) {
        push(
          {
            id: `disk-${disk.name}`,
            action: 'update',
            summary: `Grow ${disk.name} from ${liveSize} GB to ${desiredSize} GB`,
            before: liveSize,
            after: desiredSize,
          },
          ['qm', 'resize', vmid, disk.name, formatSizeGb(desiredSize)],
          false,
        );
      }
    }
    const desiredStorage = scalar(disk.storage, 'disks.storage');
    const liveStorage = scalar(liveDisk.storage, 'disks.storage');
    if (
      desiredStorage !== undefined &&
      liveStorage !== undefined &&
      desiredStorage !== liveStorage
    ) {
      warnings.push(
        `disk '${disk.name}' storage differs (YAML '${desiredStorage}', live '${liveStorage}'); storage moves are not performed by an update.`,
      );
    }
    if (diskOptionKeys(disk) !== diskOptionKeys(liveDisk)) {
      warnings.push(
        `disk '${disk.name}' options differ; update them manually if needed.`,
      );
    }
  }
  for (const name of liveDisks.keys()) {
    if (!desiredDisks.has(name)) {
      warnings.push(
        `The live VM has disk '${name}' that is not declared in YAML; it is left unchanged.`,
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
      'A running VM is restarted after the update so the new configuration takes effect.',
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

/** State used to fingerprint a VM update plan against YAML and live config. */
export function vmUpdateState(desired: Vm, live: Vm): unknown {
  return { desired, live };
}

async function readLiveConfig(transport: Transport, vmid: number): Promise<Vm> {
  const result = await transport.exec(['qm', 'config', String(vmid)], {
    timeoutMs: 10_000,
  });
  if (result.exitCode !== 0) {
    throw new VmUpdateError(
      `Failed to read the configuration of VM ${vmid}: ${
        result.stderr.trim() || `exit code ${result.exitCode}`
      }`,
    );
  }
  const parsed = parseVmProxmoxConfig(result.stdout, vmid);
  if (parsed.type !== 'vm') {
    throw new VmUpdateError(`Guest ${vmid} is not a VM`);
  }
  return parsed;
}

function describeRemaining(plan: VmUpdatePlan): string {
  return plan.changes.map((change) => change.id).join(', ');
}

/**
 * Journaled steps that re-read the live config, apply only the reviewed diff
 * and verify the result. A running VM is restarted when any change needs it.
 */
export function createVmUpdateSteps(
  desired: Vm,
  options: VmUpdateStepOptions,
): readonly JournaledStep<undefined>[] {
  const vmid = desired.id;
  const hostId = options.hostId;
  const steps: JournaledStep<undefined>[] = [
    {
      name: `update configuration of VM ${vmid}`,
      check: async ({ transport }) => {
        const live = await readLiveConfig(transport, vmid);
        const plan = planVmUpdate(desired, live);
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
        const plan = planVmUpdate(desired, live);
        if (plan.blocked) throw blockedError(plan);
        for (const argv of plan.commands) {
          const result = await transport.exec(argv, {
            timeoutMs: 120_000,
            onOutput: (stream, line) => {
              void logger.info(`${argv.join(' ')} ${stream}: ${line}`);
            },
          });
          if (result.exitCode !== 0) {
            throw new VmUpdateError(
              `Command '${argv.join(' ')}' failed for VM ${vmid}: ${
                result.stderr.trim() || `exit code ${result.exitCode}`
              }`,
            );
          }
        }
        return { status: 'applied', commands: plan.commands };
      },
      verify: async ({ transport }) => {
        const live = await readLiveConfig(transport, vmid);
        const pending = vmPendingKeys(live);
        if (options.restartRequired && pending.length > 0) {
          return { pending };
        }
        const plan = planVmUpdate(desired, live);
        if (plan.blocked) throw blockedError(plan);
        if (plan.changes.length === 0) {
          return { changes: 0, pending };
        }
        throw new VmUpdateError(
          `VM ${vmid} still differs after update: ${describeRemaining(plan)}`,
        );
      },
      rollbackHint: `Review the previous values in the plan and run 'qm set ${vmid} ...' manually on ${hostId} to restore them.`,
    },
  ];

  if (options.restartRequired) {
    steps.push({
      name: `restart VM ${vmid} to apply pending configuration`,
      check: async ({ transport }) => {
        const live = await readLiveConfig(transport, vmid);
        if (vmPendingKeys(live).length === 0) {
          const plan = planVmUpdate(desired, live);
          if (plan.changes.length === 0) {
            return { status: 'satisfied', detail: { pending: 0 } };
          }
        }
        if (!options.restart) {
          throw new VmUpdateError(
            `VM ${vmid} requires a restart but no restart hook is configured`,
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
        const pending = vmPendingKeys(live);
        if (pending.length > 0) {
          throw new VmUpdateError(
            `VM ${vmid} still has pending configuration after restart: ${pending.join(', ')}`,
          );
        }
        const plan = planVmUpdate(desired, live);
        if (plan.blocked) throw blockedError(plan);
        if (plan.changes.length > 0) {
          throw new VmUpdateError(
            `VM ${vmid} still differs after restart: ${describeRemaining(plan)}`,
          );
        }
        return { pending: 0, changes: 0 };
      },
      rollbackHint: `Start VM ${vmid} on ${hostId} again if the restart left it stopped, then inspect 'qm config ${vmid}'.`,
    });
  }

  return steps;
}

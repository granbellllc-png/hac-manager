import type { PlanChange } from '../plans/types.js';
import type { JournaledStep } from '../steps/types.js';
import type { Transport } from '../transport/types.js';

export type GuestDeleteType = 'lxc' | 'vm';

/** A live guest considered for deletion, whether or not it has YAML. */
export interface GuestDeleteTarget {
  readonly hostId: string;
  readonly vmid: number;
  readonly type: GuestDeleteType;
  readonly name: string;
  readonly status: string;
  readonly protection: boolean;
  readonly mounts?: readonly {
    readonly index: number;
    readonly host_path: string;
    readonly guest_path: string;
    readonly backup?: boolean | undefined;
  }[];
  readonly backup_storage?: string | undefined;
}

export interface GuestDeleteOptions {
  /** Take a `vzdump` backup before touching the guest. */
  readonly backup?: boolean | undefined;
  /** Override the deployment's `backup_storage`. */
  readonly backupStorage?: string | undefined;
  /** Proxmox purge: remove unreferenced disks and other leftovers. */
  readonly purge?: boolean | undefined;
  /**
   * Explicitly lift Proxmox protection immediately before deletion. Without
   * this, a protected guest is never deleted.
   */
  readonly unprotect?: boolean | undefined;
}

export interface GuestDeletePlan {
  readonly summary: string;
  readonly changes: readonly PlanChange[];
  readonly warnings: readonly string[];
  readonly commands: readonly (readonly string[])[];
  readonly destructive: true;
  readonly blocked: boolean;
  readonly blockReason?: string | undefined;
}

/** A rejected deletion, for example an undeclared protection flag. */
export class GuestDeleteError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'GuestDeleteError';
  }
}

function toolFor(type: GuestDeleteType): 'pct' | 'qm' {
  return type === 'lxc' ? 'pct' : 'qm';
}

function configPath(type: GuestDeleteType, vmid: number): string {
  return type === 'lxc'
    ? `/etc/pve/local/lxc/${vmid}.conf`
    : `/etc/pve/local/qemu-server/${vmid}.conf`;
}

export function guestDeleteBackupArgv(
  target: GuestDeleteTarget,
  options: GuestDeleteOptions,
): readonly string[] {
  const argv = [
    'vzdump',
    String(target.vmid),
    '--mode',
    'snapshot',
    '--compress',
    'zstd',
  ];
  const storage = options.backupStorage ?? target.backup_storage;
  if (storage) argv.push('--storage', storage);
  return argv;
}

export function guestDeleteUnprotectArgv(
  target: GuestDeleteTarget,
): readonly string[] {
  return [
    toolFor(target.type),
    'set',
    String(target.vmid),
    '--protection',
    '0',
  ];
}

export function guestDeleteStopArgv(
  target: GuestDeleteTarget,
): readonly string[] {
  return [toolFor(target.type), 'stop', String(target.vmid)];
}

export function guestDeleteDestroyArgv(
  target: GuestDeleteTarget,
  options: GuestDeleteOptions,
): readonly string[] {
  const argv = [toolFor(target.type), 'destroy', String(target.vmid)];
  if (options.purge) {
    argv.push('--purge', '1');
    if (target.type === 'vm') {
      argv.push('--destroy-unreferenced-disks', '1');
    }
  }
  return argv;
}

/**
 * Pure deletion plan. A protected guest blocks the plan unless the caller
 * explicitly opts in to lifting protection immediately before deletion.
 */
export function planGuestDeletion(
  target: GuestDeleteTarget,
  options: GuestDeleteOptions = {},
): GuestDeletePlan {
  const summary = `Delete ${target.type.toUpperCase()} ${target.vmid} (${target.name}) on ${target.hostId}`;
  if (target.protection && options.unprotect !== true) {
    return {
      summary,
      changes: [],
      warnings: [
        'Protection is enabled. Lift it with an explicit unprotect action before deleting this guest.',
      ],
      commands: [],
      destructive: true,
      blocked: true,
      blockReason: `Guest ${target.vmid} on host '${target.hostId}' is protected. Lift protection explicitly before deleting it.`,
    };
  }

  const changes: PlanChange[] = [];
  const warnings: string[] = [];
  const commands: string[][] = [];

  if (options.backup) {
    changes.push({
      id: 'backup',
      action: 'execute',
      summary: `Back up ${target.type.toUpperCase()} ${target.vmid} before deletion`,
    });
    commands.push([...guestDeleteBackupArgv(target, options)]);
    const bindMounts = (target.mounts ?? []).filter(
      (mount) => mount.backup !== false,
    );
    if (bindMounts.length > 0) {
      warnings.push(
        'vzdump does not back up bind-mounted mp data. Copy host directories separately if they matter.',
      );
    }
  } else {
    warnings.push(
      'No backup is taken. Deleting the guest and its disks cannot be undone.',
    );
  }

  if (target.protection && options.unprotect === true) {
    changes.push({
      id: 'unprotect',
      action: 'update',
      summary: 'Lift guest protection immediately before deletion',
      before: true,
      after: false,
      destructive: true,
    });
    commands.push([...guestDeleteUnprotectArgv(target)]);
    warnings.push(
      'Protection is lifted immediately before deletion; the guest remains unprotected until it is removed.',
    );
  }

  if (target.status === 'running') {
    changes.push({
      id: 'stop',
      action: 'update',
      summary: 'Stop the running guest before deletion',
      before: 'running',
      after: 'stopped',
    });
    commands.push([...guestDeleteStopArgv(target)]);
    warnings.push('The running guest is stopped before it is deleted.');
  }

  changes.push({
    id: 'delete',
    action: 'delete',
    summary: `Delete ${target.type.toUpperCase()} ${target.vmid} (${target.name})`,
    before: {
      vmid: target.vmid,
      name: target.name,
      type: target.type,
      status: target.status,
    },
    after: null,
    destructive: true,
  });
  commands.push([...guestDeleteDestroyArgv(target, options)]);

  if (options.purge) {
    warnings.push(
      'Purge is enabled: unreferenced disks and other leftovers are removed.',
    );
  }

  return {
    summary,
    changes,
    warnings,
    commands,
    destructive: true,
    blocked: false,
  };
}

/** State used to fingerprint a deletion plan against the live guest. */
export function guestDeleteState(
  target: GuestDeleteTarget,
  options: GuestDeleteOptions = {},
): unknown {
  return { target, options };
}

async function run(
  transport: Transport,
  argv: readonly string[],
  vmid: number,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const result = await transport.exec(argv, { timeoutMs: 300_000 });
  if (result.exitCode !== 0) {
    throw new GuestDeleteError(
      `Command '${argv.join(' ')}' failed for guest ${vmid}: ${
        result.stderr.trim() || `exit code ${result.exitCode}`
      }`,
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

async function configPresent(
  transport: Transport,
  target: GuestDeleteTarget,
): Promise<boolean> {
  const result = await transport.exec([
    'test',
    '-f',
    configPath(target.type, target.vmid),
  ]);
  return result.exitCode === 0;
}

async function guestStatus(
  transport: Transport,
  target: GuestDeleteTarget,
): Promise<string> {
  const result = await transport.exec([
    toolFor(target.type),
    'status',
    String(target.vmid),
  ]);
  if (result.exitCode !== 0) return 'missing';
  const match = /status:\s*(\S+)/.exec(result.stdout);
  return match?.[1] ?? 'unknown';
}

async function protectionEnabled(
  transport: Transport,
  target: GuestDeleteTarget,
): Promise<boolean> {
  const result = await transport.exec([
    toolFor(target.type),
    'config',
    String(target.vmid),
  ]);
  if (result.exitCode !== 0) return false;
  return /^\s*protection:\s*(?:1|true)\s*$/im.test(result.stdout);
}

/**
 * Journaled steps for a safe deletion: optional backup, explicit unprotect,
 * stop a running guest, destroy, then verify the config is gone.
 */
export function createGuestDeleteSteps(
  target: GuestDeleteTarget,
  options: GuestDeleteOptions = {},
): readonly JournaledStep<undefined>[] {
  const vmid = target.vmid;
  const steps: JournaledStep<undefined>[] = [];

  if (options.backup) {
    const argv = guestDeleteBackupArgv(target, options);
    steps.push({
      name: `back up ${target.type} ${vmid} before deletion`,
      check: async ({ transport }) => {
        if (!(await configPresent(transport, target))) {
          return { status: 'satisfied', detail: { missing: true } };
        }
        return { status: 'required' };
      },
      apply: async ({ transport }) => {
        await run(transport, argv, vmid);
        return { backup: true };
      },
      verify: async ({ transport }) => {
        if (!(await configPresent(transport, target))) {
          throw new GuestDeleteError(
            `Guest ${vmid} disappeared before its backup completed`,
          );
        }
        return { backup: true };
      },
      rollbackHint: `Inspect the vzdump log on ${target.hostId} and restore from the latest backup if needed.`,
    });
  }

  if (target.protection && options.unprotect === true) {
    const argv = guestDeleteUnprotectArgv(target);
    steps.push({
      name: `lift protection on ${target.type} ${vmid}`,
      check: async ({ transport }) => {
        if (!(await configPresent(transport, target))) {
          return { status: 'satisfied', detail: { missing: true } };
        }
        if (await protectionEnabled(transport, target)) {
          return { status: 'required' };
        }
        return { status: 'satisfied', detail: { protection: false } };
      },
      apply: async ({ transport }) => {
        await run(transport, argv, vmid);
        return { protection: false };
      },
      verify: async ({ transport }) => {
        if (await protectionEnabled(transport, target)) {
          throw new GuestDeleteError(
            `Guest ${vmid} is still protected after lifting protection`,
          );
        }
        return { protection: false };
      },
      rollbackHint: `Re-enable protection on ${target.hostId} for guest ${vmid} if deletion was aborted.`,
    });
  }

  steps.push({
    name: `stop ${target.type} ${vmid} before deletion`,
    check: async ({ transport }) => {
      if (!(await configPresent(transport, target))) {
        return { status: 'satisfied', detail: { missing: true } };
      }
      const status = await guestStatus(transport, target);
      if (status === 'stopped' || status === 'missing') {
        return { status: 'satisfied', detail: { status } };
      }
      return { status: 'required', detail: { status } };
    },
    apply: async ({ transport }) => {
      await run(transport, guestDeleteStopArgv(target), vmid);
      return { status: 'stopped' };
    },
    verify: async ({ transport }) => {
      const status = await guestStatus(transport, target);
      if (status !== 'stopped' && status !== 'missing') {
        throw new GuestDeleteError(
          `Guest ${vmid} is '${status}' after stop, expected 'stopped'`,
        );
      }
      return { status };
    },
    rollbackHint: `Start guest ${vmid} on ${target.hostId} again if deletion was aborted.`,
  });

  const destroyArgv = guestDeleteDestroyArgv(target, options);
  steps.push({
    name: `delete ${target.type} ${vmid}`,
    check: async ({ transport }) => {
      if (!(await configPresent(transport, target))) {
        return { status: 'satisfied', detail: { missing: true } };
      }
      return { status: 'required' };
    },
    apply: async ({ transport }) => {
      await run(transport, destroyArgv, vmid);
      return { deleted: true };
    },
    verify: async ({ transport }) => {
      if (await configPresent(transport, target)) {
        throw new GuestDeleteError(
          `Guest ${vmid} still has a configuration file after deletion`,
        );
      }
      return { deleted: true };
    },
    rollbackHint: `Restore guest ${vmid} from backup if it was deleted by mistake; the deletion is not reversible otherwise.`,
  });

  return steps;
}

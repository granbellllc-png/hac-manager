/**
 * Adoption of a container created by a community script (D-41, D-45).
 *
 * A helper script creates an ordinary, unstamped Proxmox container. Before it
 * is considered managed, the guest is stopped, its application data is moved
 * from the rootfs to the host-backed `mp0`, it is stamped with the management
 * tag/UUID, its configured identity checks run, and it is started again. The
 * whole sequence is journaled, so a failure can be resumed instead of leaving
 * a half-adopted container behind.
 */

import {
  MANAGED_GUEST_TAG,
  managedGuestUuid,
  parseManagedGuestUuid,
  stampManagedIdentity,
} from '../guest/identity.js';
import { globalSecretRedactor } from '../redaction/index.js';
import type { GuestDeployment } from '../schema/deployment.js';
import type { JournaledStep } from '../steps/types.js';
import {
  createHostDirectoryStep,
  hostDirectoryMatches,
  readHostDirectory,
} from '../storage/host-dirs.js';
import type { ExecResult, Transport } from '../transport/types.js';
import {
  createLxcAttachMp0Step,
  createLxcBackupStep,
  createLxcDisplaceGuestPathStep,
  createLxcFinalVerifyStep,
  createLxcMountStep,
  createLxcRsyncStep,
  createLxcStartStep,
  createLxcStopStep,
  createLxcUidShiftStep,
  createLxcUnmountStep,
  lxcHasPendingConfig,
  lxcMp0Matches,
  planLxcMigration,
  readLxcConfig,
  readPowerState,
  type LxcMigrationOptions,
  type LxcMigrationPlan,
} from './lxc-migrate.js';
import { lxcConfigPath } from './lxc.js';

type Lxc = Extract<GuestDeployment, { type: 'lxc' }>;

export class CommunityScriptAdoptionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CommunityScriptAdoptionError';
  }
}

/**
 * Proxmox config keys. Description text may contain lines that look like keys,
 * so only a known key ends a field's continuation block.
 */
const CONFIG_KEY =
  /^(?:arch|cores|cpulimit|cpuunits|description|features|hostname|lock|memory|mp\d+|nameserver|net\d+|onboot|ostype|parent|protection|rootfs|searchdomain|startup|swap|tags|template|tty|unprivileged|unused\d+):/;
const IDENTITY_CHECK_TIMEOUT_MS = 60_000;

/**
 * Read one field from `pct config` output. Continuation lines belong to the
 * field until the next `key:` line, so a multi-line description survives.
 */
export function lxcConfigField(
  config: string,
  field: string,
): string | undefined {
  const lines = config.split(/\r?\n/);
  const prefix = `${field}:`;
  const start = lines.findIndex((line) => line.startsWith(prefix));
  if (start < 0) return undefined;
  const values = [lines[start]!.slice(prefix.length).trimStart()];
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index]!;
    if (CONFIG_KEY.test(line)) break;
    values.push(line);
  }
  return values.join('\n').replace(/\n+$/, '');
}

/** Parse the live management tags from a Proxmox container config. */
export function lxcConfigTags(config: string): string[] {
  const raw = lxcConfigField(config, 'tags');
  if (!raw) return [];
  return raw
    .split(';')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

export interface LxcStampPlan {
  readonly tags: readonly string[];
  readonly description: string;
  readonly changed: boolean;
}

/** Compute the stamped identity for a live container config. */
export function planLxcStamp(
  config: string,
  hostId: string,
  vmid: number,
  declaredTags: readonly string[] = [],
): LxcStampPlan {
  return stampManagedIdentity(
    {
      tags: [...new Set([...lxcConfigTags(config), ...declaredTags])],
      description: lxcConfigField(config, 'description'),
    },
    managedGuestUuid(hostId, vmid),
  );
}

/** `pct set` argv covering only the identity fields that change. */
export function lxcStampArgv(
  config: string,
  plan: LxcStampPlan,
  vmid: number,
): readonly string[] | undefined {
  if (!plan.changed) return undefined;
  const argv = ['pct', 'set', String(vmid)];
  const currentTags = lxcConfigTags(config);
  if (
    currentTags.length !== plan.tags.length ||
    currentTags.some((tag, index) => tag !== plan.tags[index])
  ) {
    argv.push('--tags', plan.tags.join(';'));
  }
  if (lxcConfigField(config, 'description') !== plan.description) {
    argv.push('--description', plan.description);
  }
  return argv.length > 3 ? argv : undefined;
}

function sanitize(value: string): string {
  return globalSecretRedactor.redactLine(value.trim()).slice(0, 500);
}

/**
 * Refuse to adopt anything that is not the container the script was asked to
 * create. A reused VMID with a different stamp, hostname or missing config
 * halts before any mutation.
 */
export function createScriptCreatedGuestStep(
  guest: Lxc,
  options: { readonly hostId: string },
): JournaledStep<undefined> {
  const configPath = lxcConfigPath(guest.id);
  const expectedUuid = managedGuestUuid(options.hostId, guest.id);
  return {
    name: `verify script-created LXC ${guest.id}`,
    check: async ({ transport }) => {
      const exists = await transport.exec(['test', '-f', configPath], {
        timeoutMs: 5_000,
      });
      if (exists.exitCode !== 0) {
        throw new CommunityScriptAdoptionError(
          `The community script did not create LXC ${guest.id}; '${configPath}' is missing on host '${options.hostId}'. Nothing was adopted.`,
        );
      }
      const config = await readLxcConfig(transport, guest.id);
      const hostname = lxcConfigField(config, 'hostname');
      if (hostname !== undefined && hostname !== guest.name) {
        throw new CommunityScriptAdoptionError(
          `LXC ${guest.id} is '${hostname}', but the YAML describes '${guest.name}'. Refusing to adopt a different workload.`,
        );
      }
      const actualUuid = parseManagedGuestUuid(
        lxcConfigField(config, 'description'),
      );
      if (actualUuid !== undefined && actualUuid !== expectedUuid) {
        throw new CommunityScriptAdoptionError(
          `LXC ${guest.id} carries management stamp '${actualUuid}', expected '${expectedUuid}'. The VMID was probably reused.`,
        );
      }
      return {
        status: 'satisfied',
        detail: { vmid: guest.id, hostname: hostname ?? guest.name },
      };
    },
    apply: async () => ({ adopted: true }),
    verify: async ({ transport }) => {
      const config = await readLxcConfig(transport, guest.id);
      if (lxcConfigField(config, 'hostname') !== guest.name) {
        throw new CommunityScriptAdoptionError(
          `LXC ${guest.id} no longer has hostname '${guest.name}'.`,
        );
      }
      return { vmid: guest.id };
    },
    rollbackHint: `Inspect 'pct config ${guest.id}' on ${options.hostId}; the container was not modified.`,
  };
}

/** Add the managed tag and deterministic UUID stamp while the guest is stopped. */
export function createLxcStampStep(
  guest: Lxc,
  options: { readonly hostId: string },
): JournaledStep<undefined> {
  const expectedUuid = managedGuestUuid(options.hostId, guest.id);
  return {
    name: `stamp LXC ${guest.id} as managed`,
    check: async ({ transport }) => {
      const config = await readLxcConfig(transport, guest.id);
      const plan = planLxcStamp(
        config,
        options.hostId,
        guest.id,
        guest.tags ?? [],
      );
      return plan.changed
        ? { status: 'required', detail: { vmid: guest.id } }
        : { status: 'satisfied', detail: { vmid: guest.id } };
    },
    apply: async ({ transport }) => {
      const config = await readLxcConfig(transport, guest.id);
      const plan = planLxcStamp(
        config,
        options.hostId,
        guest.id,
        guest.tags ?? [],
      );
      const argv = lxcStampArgv(config, plan, guest.id);
      if (!argv) return { changed: false };
      const result = await transport.exec(argv, { timeoutMs: 30_000 });
      if (result.exitCode !== 0) {
        throw new CommunityScriptAdoptionError(
          `Failed to stamp LXC ${guest.id}: ${
            sanitize(result.stderr) || `exit code ${result.exitCode}`
          }`,
        );
      }
      return { tags: plan.tags, description: plan.description };
    },
    verify: async ({ transport }) => {
      const config = await readLxcConfig(transport, guest.id);
      const tags = lxcConfigTags(config);
      const actualUuid = parseManagedGuestUuid(
        lxcConfigField(config, 'description'),
      );
      if (actualUuid !== expectedUuid || !tags.includes(MANAGED_GUEST_TAG)) {
        throw new CommunityScriptAdoptionError(
          `LXC ${guest.id} is not stamped as managed after adoption.`,
        );
      }
      return { uuid: expectedUuid, tags };
    },
    rollbackHint: `Stamp LXC ${guest.id} again after checking 'pct config'; the migrated data is untouched.`,
  };
}

async function runIdentityChecks(
  transport: Transport,
  vmid: number,
  checks: readonly string[],
): Promise<{ readonly check: string; readonly exitCode: number }[]> {
  const state = await readPowerState(transport, vmid);
  if (state !== 'running') {
    throw new CommunityScriptAdoptionError(
      `Identity checks for LXC ${vmid} require a running guest, but its state is '${state ?? 'unknown'}'.`,
    );
  }
  const results: { readonly check: string; readonly exitCode: number }[] = [];
  for (const check of checks) {
    const argv = ['pct', 'exec', String(vmid), '--', '/bin/sh', '-s'];
    const result: ExecResult = await transport.exec(argv, {
      stdin: `${check}\n`,
      timeoutMs: IDENTITY_CHECK_TIMEOUT_MS,
    });
    results.push({ check, exitCode: result.exitCode });
    if (result.exitCode !== 0 || result.timedOut) {
      throw new CommunityScriptAdoptionError(
        `Identity check '${check}' failed on LXC ${vmid}: ${
          sanitize(result.stderr) || `exit code ${result.exitCode}`
        }`,
      );
    }
  }
  return results;
}

/** Run the deployment's `identity_checks` inside the running guest. */
export function createLxcIdentityCheckStep(
  guest: Lxc,
): JournaledStep<undefined> {
  const checks = guest.identity_checks ?? [];
  return {
    name: `run identity checks for LXC ${guest.id}`,
    check: async () =>
      checks.length === 0
        ? { status: 'satisfied', detail: { checks: 0 } }
        : { status: 'required', detail: { checks: checks.length } },
    apply: async ({ transport }) => ({
      checks: await runIdentityChecks(transport, guest.id, checks),
    }),
    verify: async ({ transport }) => ({
      checks: await runIdentityChecks(transport, guest.id, checks),
    }),
    rollbackHint: `Inspect the guest console of LXC ${guest.id}; failed identity checks do not delete data.`,
  };
}

/** The migrated rootfs path must be empty (or gone) before mp0 is attached. */
export function createLxcRootfsEmptyStep(
  plan: LxcMigrationPlan,
): JournaledStep<undefined> {
  return {
    name: `verify rootfs ${plan.guestPath} of LXC ${plan.vmid} is empty`,
    check: async ({ transport }) => {
      const exists = await transport.exec(['test', '-e', plan.guestOptPath], {
        timeoutMs: 5_000,
      });
      if (exists.exitCode !== 0) {
        return { status: 'satisfied', detail: { empty: true } };
      }
      const result = await transport.exec(
        ['find', plan.guestOptPath, '-mindepth', '1', '-print', '-quit'],
        { timeoutMs: 60_000 },
      );
      if (result.exitCode !== 0) {
        throw new CommunityScriptAdoptionError(
          `Could not inspect '${plan.guestOptPath}': ${
            sanitize(result.stderr) || `exit code ${result.exitCode}`
          }`,
        );
      }
      return result.stdout.trim().length === 0
        ? { status: 'satisfied', detail: { empty: true } }
        : { status: 'required', detail: { empty: false } };
    },
    apply: async ({ transport }) => {
      const exists = await transport.exec(['test', '-e', plan.guestOptPath], {
        timeoutMs: 5_000,
      });
      if (exists.exitCode !== 0) return { empty: true };
      const result = await transport.exec(
        ['find', plan.guestOptPath, '-mindepth', '1', '-print', '-quit'],
        { timeoutMs: 60_000 },
      );
      if (result.exitCode !== 0 || result.stdout.trim().length > 0) {
        throw new CommunityScriptAdoptionError(
          `Rootfs path '${plan.guestOptPath}' of LXC ${plan.vmid} still contains data; refusing to attach mp0 over it (D-44).`,
        );
      }
      return { empty: true };
    },
    verify: async ({ transport }) => {
      const exists = await transport.exec(['test', '-e', plan.guestOptPath], {
        timeoutMs: 5_000,
      });
      if (exists.exitCode === 0) {
        const result = await transport.exec(
          ['find', plan.guestOptPath, '-mindepth', '1', '-print', '-quit'],
          { timeoutMs: 60_000 },
        );
        if (result.exitCode !== 0 || result.stdout.trim().length > 0) {
          throw new CommunityScriptAdoptionError(
            `Rootfs path '${plan.guestOptPath}' of LXC ${plan.vmid} is not empty after migration.`,
          );
        }
      }
      return { empty: true };
    },
    rollbackHint: `The displaced copy '${plan.displacedPath}' remains inside the rootfs; do not delete it until the migrated guest is verified.`,
  };
}

/** Final adoption invariant: mp0 effective, no `[PENDING]`, identity verified. */
export function createAdoptionFinalVerifyStep(
  guest: Lxc,
  plan: LxcMigrationPlan,
  options: { readonly hostId: string },
): JournaledStep<undefined> {
  const expectedUuid = managedGuestUuid(options.hostId, guest.id);
  return {
    name: `verify adoption of LXC ${guest.id}`,
    check: async () => ({ status: 'required' }),
    apply: async ({ transport }) => {
      const config = await readLxcConfig(transport, guest.id);
      const state = await readPowerState(transport, guest.id);
      const stat = await readHostDirectory(transport, plan.hostPath);
      if (lxcHasPendingConfig(config)) {
        throw new CommunityScriptAdoptionError(
          `LXC ${guest.id} still has a pending configuration after adoption. [PENDING] must be empty.`,
        );
      }
      if (!lxcMp0Matches(config, plan.mp0Value)) {
        throw new CommunityScriptAdoptionError(
          `LXC ${guest.id} does not expose the planned mp0 after adoption.`,
        );
      }
      if (state !== 'running') {
        throw new CommunityScriptAdoptionError(
          `LXC ${guest.id} is not running after adoption.`,
        );
      }
      if (!stat || !hostDirectoryMatches(plan.hostDirectory, stat)) {
        throw new CommunityScriptAdoptionError(
          `Host directory '${plan.hostPath}' does not match the planned ownership or mode.`,
        );
      }
      const actualUuid = parseManagedGuestUuid(
        lxcConfigField(config, 'description'),
      );
      if (actualUuid !== expectedUuid) {
        throw new CommunityScriptAdoptionError(
          `LXC ${guest.id} is not stamped with '${expectedUuid}' after adoption.`,
        );
      }
      return {
        vmid: guest.id,
        mp0: plan.mp0Value,
        hostPath: plan.hostPath,
        stamp: expectedUuid,
      };
    },
    verify: async ({ transport }) => {
      const config = await readLxcConfig(transport, guest.id);
      if (
        lxcHasPendingConfig(config) ||
        !lxcMp0Matches(config, plan.mp0Value)
      ) {
        throw new CommunityScriptAdoptionError(
          `LXC ${guest.id} changed its mp0 or pending state during adoption verification.`,
        );
      }
      return { mp0: plan.mp0Value };
    },
    rollbackHint: `The displaced rootfs copy '${plan.displacedPath}' is still available; the guest is running with host-backed ${plan.guestPath}.`,
  };
}

export interface CommunityScriptAdoptionOptions extends LxcMigrationOptions {
  /** Run the deployment's identity checks. Defaults to true. */
  readonly runIdentityChecks?: boolean | undefined;
}

/**
 * Complete journaled adoption of a script-created LXC:
 * host directory, optional backup, stop, rootfs→host migration, stamp,
 * start, identity checks and final invariant verification.
 */
export function createCommunityScriptAdoptionSteps(
  guest: GuestDeployment,
  options: CommunityScriptAdoptionOptions,
): readonly JournaledStep<undefined>[] {
  if (guest.type !== 'lxc') {
    throw new CommunityScriptAdoptionError(
      `Community script adoption only applies to LXC containers, not ${guest.type}.`,
    );
  }
  const plan = planLxcMigration(guest, options);
  const steps: JournaledStep<undefined>[] = [
    createScriptCreatedGuestStep(guest, options),
    createHostDirectoryStep(plan.hostDirectory),
  ];
  if (plan.backup) steps.push(createLxcBackupStep(plan, options));
  steps.push(
    createLxcStopStep(plan),
    createLxcMountStep(plan),
    createLxcRsyncStep(plan),
    createLxcUidShiftStep(plan),
    createLxcDisplaceGuestPathStep(plan),
    createLxcRootfsEmptyStep(plan),
    createLxcUnmountStep(plan),
    createLxcAttachMp0Step(plan),
    createLxcStampStep(guest, options),
    createLxcStartStep(plan),
  );
  if (options.runIdentityChecks !== false) {
    steps.push(createLxcIdentityCheckStep(guest));
  }
  steps.push(
    // Migration steps normally end by starting the guest; adoption also stamps
    // and runs identity checks, so the final invariant check closes the run.
    createLxcFinalVerifyStep(plan),
    createAdoptionFinalVerifyStep(guest, plan, options),
  );
  return steps;
}

import { posix } from 'node:path';
import type { GuestDeployment } from '../schema/deployment.js';
import type { JournaledStep } from '../steps/types.js';
import type { Transport } from '../transport/types.js';

/** Convention from D-43: host-backed guest data lives below this root. */
export const DEFAULT_HOST_DATA_ROOT = '/opt/server-data';
export const DEFAULT_UNPRIVILEGED_UID_BASE = 100_000;
export const HOST_DIRECTORY_MINIMAL_MODE = '0750';
export const HOST_DIRECTORY_WORLD_WRITABLE_MODE = '2777';

export interface GuestIdMap {
  readonly uidBase: number;
  readonly gidBase: number;
  readonly size?: number | undefined;
}

export interface HostDirectoryPlan {
  readonly hostPath: string;
  readonly guestPath: string;
  /** Host UID/GID the directory is chowned to. */
  readonly uid: number;
  readonly gid: number;
  /** Octal mode, for example `0750` or `2777`. */
  readonly mode: string;
  /** True when default ACLs are part of the plan (world_writable only). */
  readonly defaultAcl: boolean;
}

export interface HostDirectoryStat {
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
}

function safeSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(
      `${label} '${value}' cannot be used in a host data path; expected letters, digits, dot, underscore or dash.`,
    );
  }
  return value;
}

/**
 * `/opt/server-data/<host>/<guest>/opt` (D-43). The guest segment is the
 * guest name, which is stable in the deployment YAML.
 */
export function defaultHostDataPath(
  hostId: string,
  guestName: string,
  guestPath = '/opt',
  root = DEFAULT_HOST_DATA_ROOT,
): string {
  const relative = guestPath.replace(/^\/+/, '');
  if (!relative) {
    throw new Error('guestPath must not be the filesystem root.');
  }
  for (const segment of relative.split('/')) {
    safeSegment(segment, 'guestPath segment');
  }
  return posix.join(
    root,
    safeSegment(hostId, 'hostId'),
    safeSegment(guestName, 'guestName'),
    relative,
  );
}

/**
 * Proxmox maps container root to host 100000:100000 for unprivileged guests
 * and to 0:0 for privileged ones. An explicit declarative idmap wins.
 */
export function resolveGuestIdMap(guest: GuestDeployment): GuestIdMap {
  if (guest.type !== 'lxc') return { uidBase: 0, gidBase: 0 };
  const base = guest.unprivileged ? DEFAULT_UNPRIVILEGED_UID_BASE : 0;
  return {
    uidBase: guest.idmap?.uid_base ?? base,
    gidBase: guest.idmap?.gid_base ?? base,
    ...(guest.idmap?.size !== undefined ? { size: guest.idmap.size } : {}),
  };
}

function assertMappedId(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 4_294_967_295) {
    throw new Error(`${label} ${value} is outside the valid UID/GID range.`);
  }
}

/**
 * Turn one declared mount into the host directory ownership/ACL plan. Only
 * mp0 is host-data guarded; other mounts may point at shared host paths that
 * this tool must not chown.
 */
export function planHostDirectory(
  mount: NonNullable<
    Extract<GuestDeployment, { type: 'lxc' }>['mounts']
  >[number],
  idmap: GuestIdMap,
): HostDirectoryPlan {
  const guestUid = mount.owner?.uid ?? 0;
  const guestGid = mount.owner?.gid ?? 0;
  const uid = idmap.uidBase + guestUid;
  const gid = idmap.gidBase + guestGid;
  assertMappedId(uid, 'Mapped host UID');
  assertMappedId(gid, 'Mapped host GID');
  if (
    idmap.size !== undefined &&
    (guestUid >= idmap.size || guestGid >= idmap.size)
  ) {
    throw new Error(
      `Mount owner ${guestUid}:${guestGid} is outside the idmap size ${idmap.size}.`,
    );
  }
  const worldWritable = mount.permissions === 'world_writable';
  return {
    hostPath: mount.host_path,
    guestPath: mount.guest_path,
    uid,
    gid,
    mode: worldWritable
      ? HOST_DIRECTORY_WORLD_WRITABLE_MODE
      : HOST_DIRECTORY_MINIMAL_MODE,
    defaultAcl: worldWritable,
  };
}

/** mp0 host-directory plans for an LXC guest. VMs have no bind mounts. */
export function planHostDirectories(
  guest: GuestDeployment,
): readonly HostDirectoryPlan[] {
  if (guest.type !== 'lxc') return [];
  const idmap = resolveGuestIdMap(guest);
  return (guest.mounts ?? [])
    .filter((mount) => mount.index === 0)
    .map((mount) => planHostDirectory(mount, idmap));
}

export function hostDirectoryStatArgv(hostPath: string): readonly string[] {
  return ['stat', '-c', '%u:%g:%a', hostPath];
}

export function hostDirectoryInstallArgv(
  plan: HostDirectoryPlan,
): readonly string[] {
  return [
    'install',
    '-d',
    '-m',
    plan.mode,
    '-o',
    String(plan.uid),
    '-g',
    String(plan.gid),
    plan.hostPath,
  ];
}

/** Default ACLs are only added for the explicit world_writable opt-in. */
export function hostDirectoryAclArgv(
  plan: HostDirectoryPlan,
): readonly string[] | undefined {
  if (!plan.defaultAcl) return undefined;
  return ['setfacl', '-d', '-m', 'u::rwx,g::rwx,o::rwx', plan.hostPath];
}

export function hostDirectorySetupArgv(
  plan: HostDirectoryPlan,
): readonly (readonly string[])[] {
  const acl = hostDirectoryAclArgv(plan);
  return acl
    ? [hostDirectoryInstallArgv(plan), acl]
    : [hostDirectoryInstallArgv(plan)];
}

export function parseHostDirectoryStat(
  stdout: string,
): HostDirectoryStat | undefined {
  const [uidText, gidText, modeText] = stdout.trim().split(':');
  if (
    uidText === undefined ||
    gidText === undefined ||
    modeText === undefined
  ) {
    return undefined;
  }
  const uid = Number(uidText);
  const gid = Number(gidText);
  const mode = Number.parseInt(modeText, 8);
  if (
    !Number.isSafeInteger(uid) ||
    !Number.isSafeInteger(gid) ||
    !Number.isFinite(mode)
  ) {
    return undefined;
  }
  return { uid, gid, mode };
}

export function hostDirectoryMatches(
  plan: HostDirectoryPlan,
  stat: HostDirectoryStat,
): boolean {
  return (
    stat.uid === plan.uid &&
    stat.gid === plan.gid &&
    stat.mode === Number.parseInt(plan.mode, 8)
  );
}

function setupFailure(
  plan: HostDirectoryPlan,
  argv: readonly string[],
  exitCode: number,
  stderr: string,
): Error {
  return new Error(
    `Failed to prepare host directory '${plan.hostPath}' (${argv.join(' ')}): ${
      stderr.trim() || `exit code ${exitCode}`
    }`,
  );
}

function aclGuidance(hostPath: string): Error {
  return new Error(
    `The 'acl' package (setfacl) is required to prepare '${hostPath}' with default ACLs. Install it on the host (Tier-2 package) and retry.`,
  );
}

/**
 * Journaled steps that create one host directory with the mapped ownership and
 * minimal permissions before mp0 is attached. `world_writable` is the only
 * path that adds default ACLs, and it verifies that setfacl exists first.
 */
export function createHostDirectorySteps(
  guest: GuestDeployment,
): readonly JournaledStep<undefined>[] {
  return planHostDirectories(guest).map((plan) => ({
    name: `prepare host directory ${plan.hostPath}`,
    check: async ({ transport }) => {
      if (plan.defaultAcl) {
        const which = await transport.exec(['which', 'setfacl'], {
          timeoutMs: 5_000,
        });
        if (which.exitCode !== 0) throw aclGuidance(plan.hostPath);
      }
      const result = await transport.exec(
        hostDirectoryStatArgv(plan.hostPath),
        { timeoutMs: 5_000 },
      );
      if (result.exitCode !== 0) return { status: 'required' };
      const stat = parseHostDirectoryStat(result.stdout);
      return stat && hostDirectoryMatches(plan, stat)
        ? { status: 'satisfied', detail: { stat } }
        : { status: 'required', detail: stat };
    },
    apply: async ({ transport }) => {
      for (const argv of hostDirectorySetupArgv(plan)) {
        const result = await transport.exec(argv, { timeoutMs: 30_000 });
        if (result.exitCode !== 0) {
          throw setupFailure(plan, argv, result.exitCode, result.stderr);
        }
      }
      return {
        hostPath: plan.hostPath,
        uid: plan.uid,
        gid: plan.gid,
        mode: plan.mode,
      };
    },
    verify: async ({ transport }) => {
      const result = await transport.exec(
        hostDirectoryStatArgv(plan.hostPath),
        { timeoutMs: 5_000 },
      );
      if (result.exitCode !== 0) {
        throw setupFailure(
          plan,
          hostDirectoryStatArgv(plan.hostPath),
          result.exitCode,
          result.stderr,
        );
      }
      const stat = parseHostDirectoryStat(result.stdout);
      if (!stat || !hostDirectoryMatches(plan, stat)) {
        throw new Error(
          `Host directory '${plan.hostPath}' does not have the planned ownership or mode after preparation.`,
        );
      }
      return { stat };
    },
    rollbackHint: `Inspect '${plan.hostPath}' manually. It is never deleted automatically.`,
  }));
}

/** Read-only probe used by plans and later invariant checks. */
export async function readHostDirectory(
  transport: Transport,
  hostPath: string,
): Promise<HostDirectoryStat | undefined> {
  const result = await transport.exec(hostDirectoryStatArgv(hostPath), {
    timeoutMs: 5_000,
  });
  if (result.exitCode !== 0) return undefined;
  return parseHostDirectoryStat(result.stdout);
}

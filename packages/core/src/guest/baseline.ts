/**
 * Guest baseline steps (D-52): detect the distribution from `os-release`,
 * enforce the IPv6 sysctl policy, upgrade OS packages and finally run the
 * deployment's `update_commands`.
 *
 * Everything here runs through the caller's transport. For LXC that is the
 * `pct exec` transport from the task cascade; for VMs it is the QEMU
 * guest-agent or SSH transport. Baseline steps must never run before a
 * successful backup and identity check.
 */

import type { GuestDeployment } from '../schema/deployment.js';
import type { JournaledStep } from '../steps/types.js';
import { shellQuote } from '../tasks/runner.js';
import { globalSecretRedactor } from '../redaction/index.js';
import type { ExecResult, Transport } from '../transport/types.js';

export const OS_RELEASE_PATHS = [
  '/etc/os-release',
  '/usr/lib/os-release',
] as const;
export const IPV6_SYSCTL_PATH = '/etc/sysctl.d/99-disable-ipv6.conf';
export const OS_DETECTION_TIMEOUT_MS = 15_000;
export const PACKAGE_UPGRADE_TIMEOUT_MS = 3_600_000;
export const UPDATE_COMMAND_TIMEOUT_MS = 3_600_000;

export type GuestDistribution = 'debian' | 'ubuntu' | 'alpine';
export type GuestOsFamily = 'debian' | 'alpine';

export interface GuestOsRelease {
  readonly id: string;
  readonly idLike: readonly string[];
  readonly versionId?: string | undefined;
  readonly prettyName?: string | undefined;
}

export interface GuestOsInfo extends GuestOsRelease {
  readonly distribution: GuestDistribution;
  readonly family: GuestOsFamily;
}

export class GuestBaselineError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'GuestBaselineError';
  }
}

export interface GuestBaselinePrerequisites {
  /** A successful pre-update backup must have completed. */
  readonly backupCompleted: boolean;
  /** Identity checks must have passed for this guest. */
  readonly identityVerified: boolean;
}

function unquote(value: string): string {
  if (value.length < 2) return value;
  const quote = value[0];
  if ((quote !== '"' && quote !== "'") || value.at(-1) !== quote) return value;
  const inner = value.slice(1, -1);
  return quote === "'" ? inner : inner.replace(/\\(["\\$`])/g, '$1');
}

/**
 * Parse the shell-style key/value lines of `os-release`. Unknown keys are
 * ignored and malformed lines are skipped; a file without `ID` is invalid.
 */
export function parseOsRelease(content: string): GuestOsRelease {
  const values = new Map<string, string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    values.set(match[1]!, unquote(match[2]!.trim()));
  }
  const id = values.get('ID')?.trim().toLowerCase();
  if (!id) {
    throw new GuestBaselineError(
      'The guest os-release file has no ID; cannot plan a package upgrade.',
    );
  }
  const idLike = (values.get('ID_LIKE') ?? '')
    .split(/\s+/)
    .map((value) => value.toLowerCase())
    .filter((value) => value.length > 0);
  const versionId = values.get('VERSION_ID');
  const prettyName = values.get('PRETTY_NAME');
  return {
    id,
    idLike,
    ...(versionId !== undefined && versionId.length > 0 ? { versionId } : {}),
    ...(prettyName !== undefined && prettyName.length > 0
      ? { prettyName }
      : {}),
  };
}

/** Resolve the supported distribution and package family for an os-release. */
export function resolveGuestOs(release: GuestOsRelease): GuestOsInfo {
  const ids = [release.id, ...release.idLike];
  const distribution = ids.find(
    (id): id is GuestDistribution =>
      id === 'debian' || id === 'ubuntu' || id === 'alpine',
  );
  if (!distribution) {
    throw new GuestBaselineError(
      `Unsupported guest distribution '${release.id}'${
        release.idLike.length > 0
          ? ` (ID_LIKE=${release.idLike.join(' ')})`
          : ''
      }. Supported: Debian, Ubuntu and Alpine.`,
    );
  }
  return {
    ...release,
    distribution,
    family: distribution === 'alpine' ? 'alpine' : 'debian',
  };
}

/**
 * Read the guest's `os-release` through the supplied guest transport. The
 * fallback path matches systemd's `/usr/lib/os-release` convention.
 */
export async function detectGuestOs(
  transport: Transport,
  options: {
    readonly signal?: AbortSignal | undefined;
    readonly timeoutMs?: number | undefined;
  } = {},
): Promise<GuestOsInfo> {
  let lastError = '';
  for (const path of OS_RELEASE_PATHS) {
    const result = await transport.exec(['cat', path], {
      timeoutMs: options.timeoutMs ?? OS_DETECTION_TIMEOUT_MS,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    if (result.exitCode === 0 && result.stdout.trim().length > 0) {
      return resolveGuestOs(parseOsRelease(result.stdout));
    }
    lastError = result.stderr.trim() || `exit code ${result.exitCode}`;
  }
  throw new GuestBaselineError(
    `Could not read ${OS_RELEASE_PATHS.join(' or ')} inside the guest: ${lastError}`,
  );
}

export interface Ipv6Policy {
  /** True to disable IPv6 for every interface, false to keep it enabled. */
  readonly disable: boolean;
  readonly path: string;
  readonly content: string;
}

function ipv6Sysctl(disable: boolean): string {
  const value = disable ? '1' : '0';
  return [
    '# Managed by HAC Manager (D-52). Do not edit by hand.',
    `net.ipv6.conf.all.disable_ipv6 = ${value}`,
    `net.ipv6.conf.default.disable_ipv6 = ${value}`,
    `net.ipv6.conf.lo.disable_ipv6 = ${value}`,
    '',
  ].join('\n');
}

/**
 * IPv6 is disabled only when every declared network disables it. A guest that
 * declares IPv6 on any interface, or declares nothing at all, keeps the
 * kernel default and gets no sysctl file.
 */
export function planIpv6Policy(
  network: GuestDeployment['network'],
): Ipv6Policy | undefined {
  const declared = network
    .map((entry) => entry.ipv6)
    .filter((value): value is NonNullable<typeof value> => value !== undefined);
  if (declared.length === 0) return undefined;
  const disable = declared.every((value) => value === 'disabled');
  return {
    disable,
    path: IPV6_SYSCTL_PATH,
    content: ipv6Sysctl(disable),
  };
}

function sanitize(value: string): string {
  return globalSecretRedactor.redactLine(value.trim()).slice(0, 500);
}

async function runScript(
  transport: Transport,
  script: string,
  options: {
    readonly timeoutMs: number;
    readonly signal?: AbortSignal | undefined;
  },
): Promise<ExecResult> {
  return transport.exec(['/bin/sh', '-s'], {
    stdin: script,
    timeoutMs: options.timeoutMs,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
}

function writeFileScript(path: string, content: string): string {
  return [
    'set -eu',
    `target=${shellQuote(path)}`,
    'tmp="${target}.hacm.$$"',
    'trap \'rm -f "$tmp"\' EXIT',
    `cat > "$tmp" <<'HACM_EOF'`,
    content.replace(/\n$/, ''),
    'HACM_EOF',
    'chmod 0644 "$tmp"',
    'mv "$tmp" "$target"',
    'trap - 0',
    '',
  ].join('\n');
}

async function readProcSysctl(
  transport: Transport,
  disable: boolean,
  signal?: AbortSignal,
): Promise<boolean> {
  const expected = disable ? '1' : '0';
  for (const path of [
    '/proc/sys/net/ipv6/conf/all/disable_ipv6',
    '/proc/sys/net/ipv6/conf/default/disable_ipv6',
  ]) {
    const result = await transport.exec(['cat', path], {
      timeoutMs: 10_000,
      ...(signal !== undefined ? { signal } : {}),
    });
    if (result.exitCode !== 0 || result.stdout.trim() !== expected) {
      return false;
    }
  }
  return true;
}

/** Journaled step that writes and applies the IPv6 sysctl policy. */
export function createIpv6Step(policy: Ipv6Policy): JournaledStep<undefined> {
  const action = policy.disable ? 'disable' : 'enable';
  return {
    name: `${action} IPv6 in the guest`,
    check: async ({ transport, signal }) => {
      const file = await transport.exec(['cat', policy.path], {
        timeoutMs: 10_000,
        signal,
      });
      const fileMatches = file.exitCode === 0 && file.stdout === policy.content;
      const active = fileMatches
        ? await readProcSysctl(transport, policy.disable, signal)
        : false;
      return active
        ? { status: 'satisfied', detail: { path: policy.path } }
        : { status: 'required', detail: { fileMatches, active } };
    },
    apply: async ({ transport, signal }) => {
      const write = await runScript(
        transport,
        writeFileScript(policy.path, policy.content),
        { timeoutMs: 30_000, signal },
      );
      if (write.exitCode !== 0) {
        throw new GuestBaselineError(
          `Failed to write '${policy.path}': ${
            sanitize(write.stderr) || `exit code ${write.exitCode}`
          }`,
        );
      }
      const apply = await transport.exec(['sysctl', '-p', policy.path], {
        timeoutMs: 30_000,
        signal,
      });
      if (apply.exitCode !== 0) {
        throw new GuestBaselineError(
          `Failed to apply '${policy.path}': ${
            sanitize(apply.stderr) || `exit code ${apply.exitCode}`
          }`,
        );
      }
      return { path: policy.path, disable: policy.disable };
    },
    verify: async ({ transport, signal }) => {
      if (!(await readProcSysctl(transport, policy.disable, signal))) {
        throw new GuestBaselineError(
          `IPv6 is not ${action}d after applying '${policy.path}'.`,
        );
      }
      return { disable: policy.disable };
    },
    rollbackHint: `Inspect '${policy.path}' and 'sysctl net.ipv6.conf.all.disable_ipv6' in the guest.`,
  };
}

/** Script that upgrades OS packages for the detected package family. */
export function packageUpgradeScript(os: GuestOsInfo): string {
  if (os.family === 'alpine') {
    return ['set -eu', 'apk update', 'apk upgrade', ''].join('\n');
  }
  return [
    'set -eu',
    'export DEBIAN_FRONTEND=noninteractive',
    'apt-get update -qq',
    'apt-get -y -o Dpkg::Options::=--force-confold upgrade',
    '',
  ].join('\n');
}

/** Journaled step that upgrades the guest's OS packages. */
export function createPackageUpgradeStep(): JournaledStep<undefined> {
  return {
    name: 'upgrade guest OS packages',
    check: async ({ transport, signal }) => {
      const os = await detectGuestOs(transport, { signal });
      return {
        status: 'required',
        detail: { distribution: os.distribution },
      };
    },
    apply: async ({ transport, signal }) => {
      const os = await detectGuestOs(transport, { signal });
      const result = await runScript(transport, packageUpgradeScript(os), {
        timeoutMs: PACKAGE_UPGRADE_TIMEOUT_MS,
        signal,
      });
      if (result.exitCode !== 0) {
        throw new GuestBaselineError(
          `Package upgrade failed on ${os.distribution}: ${
            sanitize(result.stderr) || `exit code ${result.exitCode}`
          }`,
        );
      }
      return { distribution: os.distribution, family: os.family };
    },
    verify: async ({ transport, signal }) => {
      const os = await detectGuestOs(transport, { signal });
      return { distribution: os.distribution };
    },
    rollbackHint:
      'Package upgrades are not rolled back automatically; inspect the package manager log and restore from the pre-update backup if required.',
  };
}

function commandLabel(command: string, index: number): string {
  const firstLine = command.split(/\r?\n/)[0]?.trim() ?? '';
  return `update command ${index + 1}: ${firstLine.slice(0, 80)}`;
}

/** One journaled step per `update_commands` entry, in declared order. */
export function createUpdateCommandSteps(
  commands: readonly string[],
): readonly JournaledStep<undefined>[] {
  return commands.map((command, index) => ({
    name: commandLabel(command, index),
    check: async () => ({ status: 'required' }),
    apply: async ({ transport, signal }) => {
      const result = await runScript(transport, `${command}\n`, {
        timeoutMs: UPDATE_COMMAND_TIMEOUT_MS,
        signal,
      });
      if (result.exitCode !== 0) {
        throw new GuestBaselineError(
          `Update command ${index + 1} failed: ${
            sanitize(result.stderr) || `exit code ${result.exitCode}`
          }`,
        );
      }
      return { index, stdout: sanitize(result.stdout) };
    },
    verify: async () => ({ index }),
    rollbackHint:
      'Inspect the command output in the job log and restore from the pre-update backup if required.',
  }));
}

export interface GuestBaselineOptions {
  readonly prerequisites: GuestBaselinePrerequisites;
  /** OS package upgrades are part of the baseline; set false only for tests. */
  readonly packageUpgrade?: boolean | undefined;
}

/**
 * Build the post-backup, post-identity baseline sequence. Callers must prove
 * both prerequisites; the function refuses to build steps otherwise (D-52).
 */
export function createGuestBaselineSteps(
  guest: GuestDeployment,
  options: GuestBaselineOptions,
): readonly JournaledStep<undefined>[] {
  if (
    options.prerequisites.backupCompleted !== true ||
    options.prerequisites.identityVerified !== true
  ) {
    throw new GuestBaselineError(
      'Guest baseline steps require a completed backup and a passed identity check (D-52).',
    );
  }
  const steps: JournaledStep<undefined>[] = [];
  const ipv6 = planIpv6Policy(guest.network);
  if (ipv6) steps.push(createIpv6Step(ipv6));
  if (options.packageUpgrade !== false) {
    steps.push(createPackageUpgradeStep());
  }
  steps.push(...createUpdateCommandSteps(guest.update_commands ?? []));
  return steps;
}

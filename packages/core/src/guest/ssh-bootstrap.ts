/**
 * Idempotent guest SSH bootstrap (D-53).
 *
 * The steps probe the guest's SSH port, install and start `openssh-server`
 * through the guest transport when needed, synchronise the root password by
 * comparing the `/etc/shadow` SHA-512 hash (reusing its salt) and write the
 * declared `authorized_keys`. LXC and VMs share the same steps because the
 * caller supplies the `pct exec` or guest-agent transport.
 */

import { createHash } from 'node:crypto';
import type { JournaledStep } from '../steps/types.js';
import { globalSecretRedactor } from '../redaction/index.js';
import { Secret } from '../tags/secret.js';
import { shellQuote } from '../tasks/runner.js';
import type { ExecResult, Transport } from '../transport/types.js';
import { detectGuestOs } from './baseline.js';

export const SSH_DEFAULT_PORT = 22;
export const SSH_PROBE_TIMEOUT_MS = 15_000;
export const SSH_INSTALL_TIMEOUT_MS = 3_600_000;
export const SHADOW_TIMEOUT_MS = 60_000;
export const AUTHORIZED_KEYS_PATH = '/root/.ssh/authorized_keys';
export const AUTHORIZED_KEYS_DIR = '/root/.ssh';

export class SshBootstrapError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SshBootstrapError';
  }
}

export interface SshBootstrapOptions {
  readonly port?: number | undefined;
  /** Plain or resolved `!secret` root password. */
  readonly password?: string | Secret | undefined;
  readonly authorizedKeys?: readonly string[] | undefined;
  /** Stable host identity; required to derive a deterministic fallback salt. */
  readonly hostId?: string | undefined;
  readonly vmid?: number | undefined;
}

function sanitize(value: string): string {
  return globalSecretRedactor.redactLine(value.trim()).slice(0, 500);
}

function assertPort(port: number): void {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new SshBootstrapError(
      `SSH port '${String(port)}' is not an integer between 1 and 65535.`,
    );
  }
}

function assertPasswordOptions(options: SshBootstrapOptions): void {
  if (typeof options.password === 'string' && options.password.length === 0) {
    throw new SshBootstrapError('The root password must not be empty.');
  }
  if (!options.hostId || !options.hostId.trim()) {
    throw new SshBootstrapError(
      'hostId is required to synchronise a root password idempotently.',
    );
  }
  if (
    options.vmid === undefined ||
    !Number.isSafeInteger(options.vmid) ||
    options.vmid < 1
  ) {
    throw new SshBootstrapError(
      'vmid is required to synchronise a root password idempotently.',
    );
  }
}

function fallbackSalt(hostId: string, vmid: number): string {
  const digest = createHash('sha256')
    .update(`hacm-ssh:${hostId}:${vmid}`)
    .digest('base64');
  return digest.replace(/[^./0-9A-Za-z]/g, '').slice(0, 16);
}

async function runScript(
  transport: Transport,
  script: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ExecResult> {
  return transport.exec(['/bin/sh', '-s'], {
    stdin: script,
    timeoutMs,
    ...(signal !== undefined ? { signal } : {}),
  });
}

function sshProbeScript(port: number, requireOpenssl: boolean): string {
  return [
    'port_hex=$(printf "%04X" ' + String(port) + ')',
    'found=1',
    'for f in /proc/net/tcp /proc/net/tcp6; do',
    '  [ -r "$f" ] || continue',
    '  while read -r _sl local _rem state _rest; do',
    '    [ "$state" = "0A" ] || continue',
    '    case "$local" in',
    '      *":$port_hex") found=0 ;;',
    '    esac',
    '  done < "$f"',
    'done',
    '[ "$found" = 0 ] || exit 1',
    ...(requireOpenssl ? ['command -v openssl >/dev/null 2>&1 || exit 1'] : []),
    'exit 0',
    '',
  ].join('\n');
}

async function sshReady(
  transport: Transport,
  port: number,
  requireOpenssl: boolean,
  signal?: AbortSignal,
): Promise<boolean> {
  const result = await runScript(
    transport,
    sshProbeScript(port, requireOpenssl),
    SSH_PROBE_TIMEOUT_MS,
    signal,
  );
  return result.exitCode === 0;
}

function installScript(family: 'debian' | 'alpine'): string {
  if (family === 'alpine') {
    return [
      'set -eu',
      'apk add --no-cache openssh openssl shadow',
      'ssh-keygen -A',
      'rc-update add sshd default 2>/dev/null || true',
      'rc-service sshd start 2>/dev/null || /usr/sbin/sshd || true',
      '',
    ].join('\n');
  }
  return [
    'set -eu',
    'export DEBIAN_FRONTEND=noninteractive',
    'apt-get update -qq',
    'apt-get install -y openssh-server openssl',
    'ssh-keygen -A',
    'systemctl enable --now ssh 2>/dev/null || service ssh start 2>/dev/null || /usr/sbin/sshd || true',
    '',
  ].join('\n');
}

/**
 * Ensure SSH is installed and listening. When a root password is configured,
 * `openssl` must be present too because the password step hashes inside the
 * guest rather than in application memory.
 */
export function createEnsureSshStep(
  options: SshBootstrapOptions,
): JournaledStep<undefined> {
  const port = options.port ?? SSH_DEFAULT_PORT;
  assertPort(port);
  const requireOpenssl = options.password !== undefined;
  return {
    name: `ensure SSH is listening on port ${port}`,
    check: async ({ transport, signal }) =>
      (await sshReady(transport, port, requireOpenssl, signal))
        ? { status: 'satisfied', detail: { port } }
        : { status: 'required', detail: { port } },
    apply: async ({ transport, signal }) => {
      const os = await detectGuestOs(transport, { signal });
      const result = await runScript(
        transport,
        installScript(os.family),
        SSH_INSTALL_TIMEOUT_MS,
        signal,
      );
      if (result.exitCode !== 0) {
        throw new SshBootstrapError(
          `Failed to install SSH on the guest: ${
            sanitize(result.stderr) || `exit code ${result.exitCode}`
          }`,
        );
      }
      return { distribution: os.distribution, port };
    },
    verify: async ({ transport, signal }) => {
      if (!(await sshReady(transport, port, requireOpenssl, signal))) {
        throw new SshBootstrapError(
          `SSH is not listening on port ${port} after installation.`,
        );
      }
      return { port };
    },
    rollbackHint:
      'Inspect the guest package manager and sshd service status; no guest data is modified by installing SSH.',
  };
}

function rootPasswordScript(
  password: string,
  salt: string,
  update: boolean,
): string {
  return [
    'set -eu',
    `password=${shellQuote(password)}`,
    `fallback_salt=${shellQuote(salt)}`,
    `update=${shellQuote(update ? '1' : '0')}`,
    'current=$(awk -F: \'$1 == "root" { print $2; exit }\' /etc/shadow)',
    'if [ -z "$current" ]; then',
    '  echo "root is missing from /etc/shadow" >&2',
    '  exit 3',
    'fi',
    'salt=',
    'case "$current" in',
    "  '$6$'*'$'*)",
    '    rest=${current#\\$6\\$}',
    '    salt=${rest%%\\$*}',
    '    ;;',
    'esac',
    'if [ -z "$salt" ]; then salt="$fallback_salt"; fi',
    'expected=$(printf \'%s\\n\' "$password" | openssl passwd -6 -salt "$salt" -stdin)',
    'if [ "$current" = "$expected" ]; then exit 0; fi',
    'if [ "$update" = "1" ]; then',
    '  printf \'root:%s\\n\' "$expected" | chpasswd -e',
    '  exit 0',
    'fi',
    'exit 1',
    '',
  ].join('\n');
}

/**
 * Synchronise the root password. The existing `$6$` salt is reused, so an
 * unchanged password produces the same hash and the step reports satisfied.
 */
export function createRootPasswordStep(
  options: SshBootstrapOptions,
): JournaledStep<undefined> {
  if (options.password === undefined) {
    throw new SshBootstrapError('A root password is required for this step.');
  }
  assertPasswordOptions(options);
  const hostId = options.hostId!;
  const vmid = options.vmid!;
  const password =
    options.password instanceof Secret
      ? options.password.unwrap()
      : options.password;
  const salt = fallbackSalt(hostId, vmid);
  globalSecretRedactor.register(password);

  const check = async (
    transport: Transport,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    const result = await runScript(
      transport,
      rootPasswordScript(password, salt, false),
      SHADOW_TIMEOUT_MS,
      signal,
    );
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw new SshBootstrapError(
      `Could not compare the root password hash: ${
        sanitize(result.stderr) || `exit code ${result.exitCode}`
      }`,
    );
  };

  return {
    name: 'synchronise the root password',
    check: async ({ transport, signal }) =>
      (await check(transport, signal))
        ? { status: 'satisfied', detail: { user: 'root' } }
        : { status: 'required', detail: { user: 'root' } },
    apply: async ({ transport, signal }) => {
      const result = await runScript(
        transport,
        rootPasswordScript(password, salt, true),
        SHADOW_TIMEOUT_MS,
        signal,
      );
      if (result.exitCode !== 0) {
        throw new SshBootstrapError(
          `Failed to update the root password: ${
            sanitize(result.stderr) || `exit code ${result.exitCode}`
          }`,
        );
      }
      return { user: 'root', changed: true };
    },
    verify: async ({ transport, signal }) => {
      if (!(await check(transport, signal))) {
        throw new SshBootstrapError(
          'The root password hash still differs after the update.',
        );
      }
      return { user: 'root' };
    },
    rollbackHint:
      'Restore the previous /etc/shadow entry from the pre-update backup if the new root password is wrong.',
  };
}

function validateKeys(keys: readonly string[]): string[] {
  return keys.map((key, index) => {
    const normalized = key.trim();
    if (normalized.length === 0) {
      throw new SshBootstrapError(
        `authorized_keys[${index}] must not be empty.`,
      );
    }
    if (/[\r\n]/.test(normalized) || normalized.includes('\u0000')) {
      throw new SshBootstrapError(
        `authorized_keys[${index}] must be a single line without NUL.`,
      );
    }
    return normalized;
  });
}

function authorizedKeysContent(keys: readonly string[]): string {
  return keys.map((key) => `${key}\n`).join('');
}

function authorizedKeysScript(content: string): string {
  return [
    'set -eu',
    'umask 077',
    `mkdir -p ${shellQuote(AUTHORIZED_KEYS_DIR)}`,
    `target=${shellQuote(AUTHORIZED_KEYS_PATH)}`,
    'tmp="${target}.hacm.$$"',
    'trap \'rm -f "$tmp"\' EXIT',
    `cat > "$tmp" <<'HACM_EOF'`,
    content.replace(/\n$/, ''),
    'HACM_EOF',
    'chmod 0600 "$tmp"',
    'mv "$tmp" "$target"',
    `chmod 0700 ${shellQuote(AUTHORIZED_KEYS_DIR)}`,
    'trap - 0',
    '',
  ].join('\n');
}

async function readAuthorizedKeys(
  transport: Transport,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const result = await transport.exec(['cat', AUTHORIZED_KEYS_PATH], {
    timeoutMs: 10_000,
    ...(signal !== undefined ? { signal } : {}),
  });
  return result.exitCode === 0 ? result.stdout : undefined;
}

/** Write `/root/.ssh/authorized_keys` exactly as declared. */
export function createAuthorizedKeysStep(
  keys: readonly string[],
): JournaledStep<undefined> {
  const normalized = validateKeys(keys);
  const content = authorizedKeysContent(normalized);
  return {
    name: 'synchronise root authorized_keys',
    check: async ({ transport, signal }) => {
      const current = await readAuthorizedKeys(transport, signal);
      return current === content
        ? { status: 'satisfied', detail: { keys: normalized.length } }
        : { status: 'required', detail: { keys: normalized.length } };
    },
    apply: async ({ transport, signal }) => {
      const result = await runScript(
        transport,
        authorizedKeysScript(content),
        30_000,
        signal,
      );
      if (result.exitCode !== 0) {
        throw new SshBootstrapError(
          `Failed to write '${AUTHORIZED_KEYS_PATH}': ${
            sanitize(result.stderr) || `exit code ${result.exitCode}`
          }`,
        );
      }
      return { path: AUTHORIZED_KEYS_PATH, keys: normalized.length };
    },
    verify: async ({ transport, signal }) => {
      if ((await readAuthorizedKeys(transport, signal)) !== content) {
        throw new SshBootstrapError(
          `'${AUTHORIZED_KEYS_PATH}' does not match the declared keys after writing.`,
        );
      }
      return { path: AUTHORIZED_KEYS_PATH };
    },
    rollbackHint:
      'The previous authorized_keys file was replaced; restore it from the pre-update backup if access is lost.',
  };
}

/**
 * Complete idempotent SSH bootstrap. The password step needs `hostId` and
 * `vmid` so its fallback salt stays stable across runs.
 */
export function createSshBootstrapSteps(
  options: SshBootstrapOptions,
): readonly JournaledStep<undefined>[] {
  const steps: JournaledStep<undefined>[] = [createEnsureSshStep(options)];
  if (options.password !== undefined) {
    steps.push(createRootPasswordStep(options));
  }
  if (options.authorizedKeys !== undefined) {
    steps.push(createAuthorizedKeysStep(options.authorizedKeys));
  }
  return steps;
}

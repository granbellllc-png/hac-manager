import { formatSizeGb, formatOptionString } from '../codec/options.js';
import { MANAGED_GUEST_TAG, managedGuestUuid } from '../guest/identity.js';
import type { GuestDeployment } from '../schema/deployment.js';
import { isTagValue } from '../schema/common.js';
import type { JournaledStep } from '../steps/types.js';
import { Secret } from '../tags/secret.js';

/** A parsed `storage:vztmpl/file.tar.zst` reference. */
export interface LxcTemplateRef {
  readonly storage: string;
  readonly volume: string;
  readonly volid: string;
}

const TEMPLATE_PATTERN = /^([^:/\s]+):vztmpl\/([^/\s]+)$/;

export function parseLxcTemplateRef(template: string): LxcTemplateRef {
  const match = TEMPLATE_PATTERN.exec(template.trim());
  if (!match || !match[1] || !match[2]) {
    throw new Error(
      `Invalid LXC template '${template}'. Expected '<storage>:vztmpl/<file>' such as 'local:vztmpl/debian-12.tar.zst'.`,
    );
  }
  return { storage: match[1], volume: match[2], volid: template.trim() };
}

/** `pveam list <storage>` output contains either the full volid or volume. */
export function lxcTemplateAvailable(
  listOutput: string,
  ref: LxcTemplateRef,
): boolean {
  return listOutput.split(/\r?\n/).some((line) => {
    const cells = line.trim().split(/\s+/);
    return line.includes(ref.volid) || cells.includes(ref.volume);
  });
}

export function lxcTemplateListArgv(ref: LxcTemplateRef): readonly string[] {
  return ['pveam', 'list', ref.storage];
}

export function lxcTemplateDownloadArgv(
  ref: LxcTemplateRef,
): readonly string[] {
  return ['pveam', 'download', ref.storage, ref.volume];
}

export function lxcConfigPath(vmid: number): string {
  return `/etc/pve/local/lxc/${vmid}.conf`;
}

function scalar(
  value:
    string | number | boolean | { readonly tag: string } | Secret | undefined,
  field: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (value instanceof Secret) return value.unwrap();
  if (typeof value === 'object') {
    throw new Error(
      `${field} still contains an unresolved tag; evaluate the deployment before provisioning.`,
    );
  }
  return String(value);
}

function templateValue(value: unknown): string {
  if (value instanceof Secret) return value.unwrap();
  if (typeof value === 'string') return value;
  if (isTagValue(value)) {
    throw new Error(
      'installation.template still contains an unresolved tag; evaluate the deployment before provisioning.',
    );
  }
  throw new Error('installation.template must be a string.');
}

function boolValue(
  value: boolean | { readonly tag: string } | Secret | undefined,
  field: string,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (value instanceof Secret) {
    throw new Error(`${field} resolved to a secret; a boolean was expected.`);
  }
  if (typeof value === 'object') {
    throw new Error(
      `${field} still contains an unresolved tag; evaluate the deployment before provisioning.`,
    );
  }
  return value;
}

function networkOptions(
  network: GuestDeployment['network'][number],
): Record<string, string> {
  const opts: Record<string, string> = {};
  if (network.name) opts['name'] = network.name;
  const bridge = scalar(network.bridge, 'network.bridge');
  if (bridge) opts['bridge'] = bridge;
  if (network.firewall !== undefined) {
    const firewall = boolValue(network.firewall, 'network.firewall');
    if (firewall !== undefined) opts['firewall'] = firewall ? '1' : '0';
  }
  const gateway = scalar(network.gateway, 'network.gateway');
  if (gateway) opts['gw'] = gateway;
  const gateway6 = scalar(network.gateway6, 'network.gateway6');
  if (gateway6) opts['gw6'] = gateway6;
  const mac = scalar(network.mac, 'network.mac');
  if (mac) opts['hwaddr'] = mac;
  const ip = scalar(network.ip, 'network.ip');
  if (ip) opts['ip'] = ip;
  const ip6 = scalar(network.ip6, 'network.ip6');
  if (ip6) {
    opts['ip6'] = ip6;
  } else if (network.ipv6 === 'auto' || network.ipv6 === 'dhcp') {
    opts['ip6'] = network.ipv6;
  } else if (network.ipv6 === 'disabled' || network.ipv6 === 'static') {
    opts['ip6'] = 'manual';
  }
  const vlan = scalar(network.vlan, 'network.vlan');
  if (vlan) opts['tag'] = vlan;
  const mtu = scalar(network.mtu, 'network.mtu');
  if (mtu) opts['mtu'] = mtu;
  if (network.extra) {
    for (const [key, value] of Object.entries(network.extra)) {
      opts[key] = String(value);
    }
  }
  return opts;
}

function featureOptions(
  features: NonNullable<Extract<GuestDeployment, { type: 'lxc' }>['features']>,
): Record<string, string> {
  const opts: Record<string, string> = {};
  if (features.nesting) opts['nesting'] = '1';
  if (features.keyctl) opts['keyctl'] = '1';
  if (features.fuse) opts['fuse'] = '1';
  if (features.mount && features.mount.length > 0) {
    opts['mount'] = features.mount.join(';');
  }
  return opts;
}

export interface LxcCreatePreview {
  readonly summary: string;
  readonly template: LxcTemplateRef;
  readonly argv: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Build the deterministic `pct create` argv from an evaluated deployment.
 * The managed tag and UUID stamp are part of creation so a freshly created
 * guest is verifiable before its first mutation (D-38).
 */
export function buildLxcCreateArgv(
  guest: Extract<GuestDeployment, { type: 'lxc' }>,
  options: { readonly hostId: string },
): readonly string[] {
  if (guest.installation?.type !== 'template') {
    throw new Error(
      'LXC creation requires installation.type: template in the deployment.',
    );
  }
  const template = parseLxcTemplateRef(
    templateValue(guest.installation.template),
  );
  const argv: string[] = ['pct', 'create', String(guest.id), template.volid];

  const push = (flag: string, value: string | undefined): void => {
    if (value !== undefined && value !== '') argv.push(flag, value);
  };

  push('--hostname', guest.name);
  push('--cores', scalar(guest.cpu, 'cpu'));
  push('--memory', scalar(guest.ram, 'ram'));
  push('--swap', scalar(guest.swap, 'swap'));
  const unprivileged = boolValue(guest.unprivileged, 'unprivileged');
  if (unprivileged !== undefined) {
    argv.push('--unprivileged', unprivileged ? '1' : '0');
  }
  push('--ostype', guest.ostype);
  const onboot = boolValue(guest.onboot, 'onboot');
  if (onboot !== undefined) argv.push('--onboot', onboot ? '1' : '0');
  push('--startup', scalar(guest.startup, 'startup'));

  const tags = [...(guest.tags ?? [])];
  if (!tags.includes(MANAGED_GUEST_TAG)) tags.push(MANAGED_GUEST_TAG);
  argv.push('--tags', tags.join(';'));
  argv.push(
    '--description',
    `hacm-managed: ${managedGuestUuid(options.hostId, guest.id)}`,
  );

  if (guest.features) {
    const opts = featureOptions(guest.features);
    if (Object.keys(opts).length > 0) {
      argv.push('--features', formatOptionString(undefined, opts));
    }
  }

  const rootfs = guest.disks.find((disk) => disk.name === 'rootfs');
  if (rootfs) {
    const storage =
      scalar(rootfs.storage, 'disks.rootfs.storage') ?? 'local-lvm';
    const volume =
      (rootfs.extra?.['volume'] as string | undefined) ??
      `vm-${guest.id}-disk-0`;
    const size = Number(scalar(rootfs.size_gb, 'disks.rootfs.size_gb') ?? 0);
    const extra: Record<string, string> = {};
    for (const [key, value] of Object.entries(rootfs.extra ?? {})) {
      if (key !== 'volume' && key !== 'size') extra[key] = String(value);
    }
    argv.push(
      '--rootfs',
      formatOptionString(`${storage}:${volume}`, {
        size: formatSizeGb(size > 0 ? size : 8),
        ...extra,
      }),
    );
  }

  for (const mount of guest.mounts ?? []) {
    const hostPath = scalar(mount.host_path, 'mounts.host_path');
    if (!hostPath) continue;
    argv.push(
      `--mp${mount.index}`,
      formatOptionString(hostPath, {
        mp: mount.guest_path,
        ...(mount.backup ? { backup: '1' } : {}),
        ...(mount.readonly ? { ro: '1' } : {}),
      }),
    );
  }

  for (const network of guest.network) {
    argv.push(
      `--net${network.index}`,
      formatOptionString(undefined, networkOptions(network), [
        'name',
        'bridge',
        'gw',
        'hwaddr',
        'ip',
        'ip6',
        'gw6',
        'type',
      ]),
    );
  }

  return argv;
}

export function describeLxcCreation(
  guest: Extract<GuestDeployment, { type: 'lxc' }>,
  options: { readonly hostId: string },
): LxcCreatePreview {
  const argv = buildLxcCreateArgv(guest, options);
  const template = parseLxcTemplateRef(
    guest.installation?.type === 'template'
      ? templateValue(guest.installation.template)
      : '',
  );
  const warnings: string[] = [];
  if (!guest.disks.some((disk) => disk.name === 'rootfs')) {
    warnings.push(
      'No rootfs disk is declared; Proxmox storage defaults and size apply.',
    );
  }
  if (guest.unprivileged === undefined) {
    warnings.push(
      'unprivileged is not set; Proxmox applies its default privilege mode.',
    );
  }
  if (guest.mounts?.some((mount) => mount.index === 0)) {
    warnings.push(
      'mp0 will be attached at creation before the first boot (D-44).',
    );
  }
  for (const network of guest.network) {
    if (network.ipv6 === 'static' && !network.ip6) {
      warnings.push(
        `net${network.index} uses IPv6 mode 'static' without an ip6 address.`,
      );
    }
  }
  return {
    summary: `Create LXC ${guest.id} (${guest.name}) from ${template.volid}`,
    template,
    argv,
    warnings,
  };
}

export function createLxcProvisionSteps(
  guest: Extract<GuestDeployment, { type: 'lxc' }>,
  options: { readonly hostId: string },
): readonly JournaledStep<undefined>[] {
  const template = parseLxcTemplateRef(
    guest.installation?.type === 'template'
      ? templateValue(guest.installation.template)
      : '',
  );
  const argv = buildLxcCreateArgv(guest, options);
  const expectedStamp = managedGuestUuid(options.hostId, guest.id);
  const configPath = lxcConfigPath(guest.id);

  return [
    {
      name: `ensure template ${template.volume}`,
      check: async ({ transport }) => {
        const result = await transport.exec(lxcTemplateListArgv(template), {
          timeoutMs: 30_000,
        });
        if (result.exitCode !== 0) {
          throw new Error(
            `Failed to list templates on storage '${template.storage}': ${
              result.stderr.trim() || `exit code ${result.exitCode}`
            }`,
          );
        }
        return lxcTemplateAvailable(result.stdout, template)
          ? { status: 'satisfied', detail: { template: template.volid } }
          : { status: 'required', detail: { template: template.volid } };
      },
      apply: async ({ transport }) => {
        const result = await transport.exec(lxcTemplateDownloadArgv(template), {
          timeoutMs: 300_000,
        });
        if (result.exitCode !== 0) {
          throw new Error(
            `Failed to download template '${template.volid}': ${
              result.stderr.trim() || `exit code ${result.exitCode}`
            }`,
          );
        }
        return { template: template.volid };
      },
      verify: async ({ transport }) => {
        const result = await transport.exec(lxcTemplateListArgv(template), {
          timeoutMs: 30_000,
        });
        if (
          result.exitCode !== 0 ||
          !lxcTemplateAvailable(result.stdout, template)
        ) {
          throw new Error(
            `Template '${template.volid}' is not available after download.`,
          );
        }
        return { template: template.volid };
      },
      rollbackHint: `Re-run the download or remove the partial template from storage '${template.storage}' before retrying.`,
    },
    {
      name: `create LXC ${guest.id}`,
      check: async ({ transport }) => {
        const exists = await transport.exec(['test', '-f', configPath], {
          timeoutMs: 5_000,
        });
        if (exists.exitCode !== 0) return { status: 'required' };

        const config = await transport.exec(
          ['pct', 'config', String(guest.id)],
          {
            timeoutMs: 10_000,
          },
        );
        if (
          config.exitCode === 0 &&
          config.stdout.includes(`hostname: ${guest.name}`) &&
          config.stdout.includes(expectedStamp)
        ) {
          return {
            status: 'satisfied',
            detail: { vmid: guest.id, name: guest.name },
          };
        }
        throw new Error(
          `VMID ${guest.id} is already occupied by a different workload on host '${options.hostId}'. Refusing to create over it.`,
        );
      },
      apply: async ({ transport, logger }) => {
        const result = await transport.exec(argv, {
          timeoutMs: 300_000,
          onOutput: (stream, line) => {
            void logger.info(`pct create ${stream}: ${line}`);
          },
        });
        if (result.exitCode !== 0) {
          throw new Error(
            `Failed to create LXC ${guest.id}: ${
              result.stderr.trim() || `exit code ${result.exitCode}`
            }`,
          );
        }
        return { vmid: guest.id, argv };
      },
      verify: async ({ transport }) => {
        const result = await transport.exec(
          ['pct', 'config', String(guest.id)],
          {
            timeoutMs: 10_000,
          },
        );
        if (result.exitCode !== 0) {
          throw new Error(
            `LXC ${guest.id} was not found after create: ${
              result.stderr.trim() || `exit code ${result.exitCode}`
            }`,
          );
        }
        if (
          !result.stdout.includes(`hostname: ${guest.name}`) ||
          !result.stdout.includes(expectedStamp) ||
          !result.stdout.includes(MANAGED_GUEST_TAG)
        ) {
          throw new Error(
            `LXC ${guest.id} is missing its hostname or management stamp after create.`,
          );
        }
        return { vmid: guest.id, stamp: expectedStamp };
      },
      rollbackHint: `The container was created but verification failed. Inspect it and destroy it only through an explicit confirmed action.`,
    },
  ];
}

/** True when the deployment still contains unresolved tags. */
export function hasUnresolvedTags(guest: GuestDeployment): boolean {
  const visit = (value: unknown): boolean => {
    if (isTagValue(value)) return true;
    if (Array.isArray(value)) return value.some(visit);
    if (value && typeof value === 'object') {
      return Object.values(value).some(visit);
    }
    return false;
  };
  return visit(guest);
}

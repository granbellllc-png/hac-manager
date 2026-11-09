import { formatOptionString, formatSizeGb } from '../codec/options.js';
import { parseVmProxmoxConfig } from '../codec/vm.js';
import { MANAGED_GUEST_TAG, managedGuestUuid } from '../guest/identity.js';
import type { GuestDeployment } from '../schema/deployment.js';
import { isTagValue } from '../schema/common.js';
import type { JournaledStep } from '../steps/types.js';
import { Secret } from '../tags/secret.js';
import type { Transport } from '../transport/types.js';

type Vm = Extract<GuestDeployment, { type: 'vm' }>;
type VmDisk = Vm['disks'][number];

export interface VmCreatePreview {
  readonly summary: string;
  /** Template ID, cloud image URL or "empty VM". */
  readonly origin: string;
  /** Commands the create plan runs, in order, including download/import. */
  readonly commands: readonly (readonly string[])[];
  readonly warnings: readonly string[];
}

export interface VmStepOptions {
  readonly hostId: string;
  /** Attempts before reporting a missing guest agent. Defaults to 60. */
  readonly agentAttempts?: number | undefined;
  /** Seconds between guest-agent attempts. Defaults to 3. */
  readonly agentDelaySeconds?: number | undefined;
}

export function vmConfigPath(vmid: number): string {
  return `/etc/pve/local/qemu-server/${vmid}.conf`;
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
  if (isTagValue(value)) {
    throw new Error(
      `${field} still contains an unresolved tag; evaluate the deployment before provisioning.`,
    );
  }
  throw new Error(`${field} must be a scalar value.`);
}

function boolValue(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value instanceof Secret) {
    throw new Error(`${field} resolved to a secret; a boolean was expected.`);
  }
  if (typeof value === 'boolean') return value;
  if (isTagValue(value)) {
    throw new Error(
      `${field} still contains an unresolved tag; evaluate the deployment before provisioning.`,
    );
  }
  throw new Error(`${field} must be a boolean.`);
}

function numberValue(value: unknown, field: string): number | undefined {
  const text = scalar(value, field);
  if (text === undefined || text === '') return undefined;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} must be a finite number.`);
  }
  return parsed;
}

function firstDisk(guest: Vm): VmDisk | undefined {
  return guest.disks[0];
}

function storageOf(guest: Vm): string {
  return scalar(firstDisk(guest)?.storage, 'disks[0].storage') ?? 'local-lvm';
}

function managedTags(tags: readonly string[] | undefined): string[] {
  const set = new Set(tags ?? []);
  set.add(MANAGED_GUEST_TAG);
  return [...set];
}

const VM_NETWORK_ORDER = [
  'virtio',
  'e1000',
  'rtl8139',
  'vmxnet3',
  'bridge',
  'firewall',
  'tag',
  'mtu',
] as const;

/** Canonical `netN` value used for both `qm` commands and drift comparison. */
export function formatVmNetwork(
  network: GuestDeployment['network'][number],
): string {
  const model = (network.extra?.['model'] as string | undefined) ?? 'virtio';
  const opts: Record<string, string> = {};
  const mac = scalar(network.mac, 'network.mac');
  if (mac) opts[model] = mac;
  const bridge = scalar(network.bridge, 'network.bridge');
  if (bridge) opts['bridge'] = bridge;
  const firewall = boolValue(network.firewall, 'network.firewall');
  if (firewall !== undefined) opts['firewall'] = firewall ? '1' : '0';
  const vlan = scalar(network.vlan, 'network.vlan');
  if (vlan) opts['tag'] = vlan;
  const mtu = scalar(network.mtu, 'network.mtu');
  if (mtu) opts['mtu'] = mtu;
  if (network.extra) {
    for (const [key, value] of Object.entries(network.extra)) {
      if (key === 'model') continue;
      opts[key] = String(value);
    }
  }
  return formatOptionString(undefined, opts, VM_NETWORK_ORDER);
}

/** Canonical `ipconfigN` value, or undefined when no IP setting is declared. */
export function formatVmIpConfig(
  network: GuestDeployment['network'][number],
): string | undefined {
  const opts: Record<string, string> = {};
  const ip = scalar(network.ip, 'network.ip');
  if (ip) opts['ip'] = ip;
  const gateway = scalar(network.gateway, 'network.gateway');
  if (gateway) opts['gw'] = gateway;
  const ip6 = scalar(network.ip6, 'network.ip6');
  if (ip6) opts['ip6'] = ip6;
  const gateway6 = scalar(network.gateway6, 'network.gateway6');
  if (gateway6) opts['gw6'] = gateway6;
  if (Object.keys(opts).length === 0) return undefined;
  return formatOptionString(undefined, opts, ['ip', 'gw', 'ip6', 'gw6']);
}

function cloudImageName(url: string): string {
  const path = url.split(/[?#]/, 1)[0] ?? url;
  const raw = path.split('/').pop() ?? 'cloud-image.img';
  const clean = raw.replace(/[^A-Za-z0-9._-]/g, '_');
  return clean.length > 0 ? clean : 'cloud-image.img';
}

/** Host-local download path for a cloud image. Deterministic per VM. */
export function cloudImagePath(vmid: number, url: string): string {
  return `/var/tmp/hacm-vm-${vmid}-${cloudImageName(url)}`;
}

export function cloudImageDownloadArgv(
  vmid: number,
  url: string,
): readonly string[] {
  return [
    'curl',
    '-fsSL',
    '--retry',
    '3',
    '--output',
    cloudImagePath(vmid, url),
    url,
  ];
}

function cloudImageUrl(guest: Vm): string | undefined {
  return guest.installation?.type === 'cloud_image'
    ? guest.installation.url
    : undefined;
}

function checksumValue(guest: Vm): string | undefined {
  if (guest.installation?.type !== 'cloud_image') return undefined;
  const checksum = guest.installation.checksum;
  if (!checksum) return undefined;
  return checksum.replace(/^sha256:/i, '').toLowerCase();
}

/**
 * Build the `qm create`/`qm clone` command that reserves the VMID without any
 * configuration that needs to be verified later. Managed tags and the identity
 * stamp are applied by the configure step.
 */
export function buildVmCreateArgv(
  guest: Vm,
  options: { readonly hostId: string },
): readonly string[] {
  const installation = guest.installation;
  if (
    installation &&
    installation.type !== 'clone' &&
    installation.type !== 'cloud_image'
  ) {
    throw new Error(
      'VM creation requires installation.type: clone or cloud_image, or no installation.',
    );
  }
  if (installation?.type === 'clone') {
    const argv: string[] = [
      'qm',
      'clone',
      String(installation.template_id),
      String(guest.id),
      '--name',
      guest.name,
      '--full',
      installation.full === false ? '0' : '1',
    ];
    const storage = firstDisk(guest)
      ? scalar(firstDisk(guest)?.storage, 'disks[0].storage')
      : undefined;
    if (storage) argv.push('--storage', storage);
    return argv;
  }
  const argv: string[] = [
    'qm',
    'create',
    String(guest.id),
    '--name',
    guest.name,
    '--cores',
    scalar(guest.cpu, 'cpu') ?? '1',
    '--memory',
    scalar(guest.ram, 'ram') ?? '1024',
  ];
  if (guest.disks.length > 0) {
    argv.push('--scsihw', 'virtio-scsi-pci');
  }
  if (options.hostId.trim() === '') {
    throw new Error('hostId is required');
  }
  return argv;
}

function diskOption(disk: VmDisk): string {
  const storage = scalar(disk.storage, 'disks.storage') ?? 'local-lvm';
  const size = numberValue(disk.size_gb, 'disks.size_gb') ?? 1;
  const opts: Record<string, string> = {};
  for (const [key, value] of Object.entries(disk.extra ?? {})) {
    if (key === 'volume' || key === 'size') continue;
    const text = scalar(value, `disks.${disk.name}.${key}`);
    if (text !== undefined && text !== '') opts[key] = text;
  }
  return formatOptionString(`${storage}:${size}`, opts);
}

const RESERVED_EXTRA = new Set([
  'name',
  'cores',
  'memory',
  'bios',
  'machine',
  'agent',
  'protection',
  'tags',
  'description',
  'scsihw',
  'boot',
  'bootdisk',
  'ide2',
  'ciuser',
  'cipassword',
  'sshkeys',
  'efidisk0',
  'tpmstate0',
]);

function isManagedExtraKey(key: string): boolean {
  if (RESERVED_EXTRA.has(key)) return true;
  if (key.startsWith('_')) return true;
  return /^(net|ipconfig|unused)\d+$/.test(key);
}

function appendDiskArgv(argv: string[], guest: Vm, skipFirst: boolean): void {
  const disks = skipFirst ? guest.disks.slice(1) : guest.disks;
  for (const disk of disks) {
    argv.push(`--${disk.name}`, diskOption(disk));
  }
  if (guest.disks.length > 0) {
    argv.push('--scsihw', 'virtio-scsi-pci');
  }
  const bootDisk = firstDisk(guest)?.name;
  if (bootDisk) {
    argv.push('--boot', 'c', '--bootdisk', bootDisk);
  }
}

/**
 * Build `qm set` with every managed VM option. Disks are included except the
 * first disk when it is the target of `qm importdisk`.
 */
export function buildVmConfigureArgv(
  guest: Vm,
  options: { readonly hostId: string },
): readonly string[] {
  const argv: string[] = ['qm', 'set', String(guest.id)];
  const push = (flag: string, value: string | undefined): void => {
    if (value !== undefined && value !== '') argv.push(flag, value);
  };

  const storage = storageOf(guest);
  push('--bios', guest.efi_disk && !guest.bios ? 'ovmf' : guest.bios);
  push('--machine', guest.machine);
  if (guest.guest_agent) {
    argv.push('--agent', 'enabled=1');
  }
  if (guest.efi_disk) {
    argv.push('--efidisk0', `${storage}:1,efitype=4m,pre-enrolled-keys=1`);
  }
  if (guest.tpm) {
    argv.push('--tpmstate0', `${storage}:1,version=v2.0`);
  }
  const protection = boolValue(guest.protection, 'protection');
  if (protection !== undefined) {
    argv.push('--protection', protection ? '1' : '0');
  }
  argv.push('--tags', managedTags(guest.tags).join(';'));
  argv.push(
    '--description',
    `hacm-managed: ${managedGuestUuid(options.hostId, guest.id)}`,
  );

  for (const network of guest.network) {
    argv.push(`--net${network.index}`, formatVmNetwork(network));
    const ipconfig = formatVmIpConfig(network);
    if (ipconfig) argv.push(`--ipconfig${network.index}`, ipconfig);
  }

  if (guest.cloud_init) {
    push('--ciuser', scalar(guest.cloud_init.user, 'cloud_init.user'));
    push(
      '--cipassword',
      scalar(guest.cloud_init.password, 'cloud_init.password'),
    );
    if (guest.cloud_init.ssh_keys && guest.cloud_init.ssh_keys.length > 0) {
      const keys = guest.cloud_init.ssh_keys
        .map((key) => scalar(key, 'cloud_init.ssh_keys') ?? '')
        .join('\n');
      push('--sshkeys', encodeURIComponent(keys));
    }
  }
  const needsCloudInitDrive =
    Boolean(guest.cloud_init) ||
    Boolean(cloudImageUrl(guest)) ||
    guest.network.some((network) => formatVmIpConfig(network) !== undefined);
  if (needsCloudInitDrive) {
    argv.push('--ide2', `${storage}:cloudinit`);
  }

  const cloudImage = cloudImageUrl(guest);
  appendDiskArgv(argv, guest, Boolean(cloudImage));

  for (const [key, value] of Object.entries(guest.extra ?? {})) {
    if (isManagedExtraKey(key)) continue;
    if (/^(scsi|virtio|sata|ide)\d+$/.test(key)) continue;
    const text = scalar(value, `extra.${key}`);
    if (text !== undefined && text !== '') argv.push(`--${key}`, text);
  }

  return argv;
}

export function buildVmImportArgv(
  guest: Vm,
  imagePath: string,
): readonly string[] {
  const disk = firstDisk(guest);
  if (!disk) {
    throw new Error(
      'Cloud-image VM creation requires at least one disk (for example scsi0).',
    );
  }
  return [
    'qm',
    'importdisk',
    String(guest.id),
    imagePath,
    scalar(disk.storage, 'disks[0].storage') ?? 'local-lvm',
  ];
}

function originLabel(guest: Vm): string {
  const installation = guest.installation;
  if (installation?.type === 'clone') {
    return `template ${installation.template_id}`;
  }
  if (installation?.type === 'cloud_image') return installation.url;
  return 'empty VM';
}

export function describeVmCreation(
  guest: Vm,
  options: { readonly hostId: string },
): VmCreatePreview {
  const commands: string[][] = [];
  const cloudImage = cloudImageUrl(guest);
  if (cloudImage) {
    commands.push([...cloudImageDownloadArgv(guest.id, cloudImage)]);
  }
  commands.push([...buildVmCreateArgv(guest, options)]);
  if (cloudImage && firstDisk(guest)) {
    commands.push([
      ...buildVmImportArgv(guest, cloudImagePath(guest.id, cloudImage)),
    ]);
  }
  commands.push([...buildVmConfigureArgv(guest, options)]);

  const warnings: string[] = [];
  if (guest.disks.length === 0) {
    warnings.push(
      'No VM disks are declared; the VM is created without a boot disk.',
    );
  }
  if (cloudImage && guest.disks.length === 0) {
    warnings.push(
      'Cloud-image creation needs a disk; add a scsi0 (or similar) entry.',
    );
  }
  if (guest.cloud_init && !guest.guest_agent) {
    warnings.push(
      'Cloud-init is configured but guest_agent is not enabled; HAC Manager cannot wait for the agent or verify the guest through it.',
    );
  }
  if (guest.efi_disk && guest.bios !== 'ovmf') {
    warnings.push('efi_disk is enabled; BIOS is set to ovmf for the EFI disk.');
  }
  if (guest.tpm && guest.bios !== 'ovmf') {
    warnings.push(
      'tpm is enabled but the BIOS is not ovmf; Proxmox may reject the TPM state disk.',
    );
  }
  if (guest.installation?.type === 'clone') {
    warnings.push(
      'Cloned disks inherit the template size; declared sizes only grow and are never shrunk.',
    );
  }
  return {
    summary: `Create VM ${guest.id} (${guest.name}) from ${originLabel(guest)}`,
    origin: originLabel(guest),
    commands,
    warnings,
  };
}

async function readVmConfig(
  transport: Transport,
  vmid: number,
): Promise<string> {
  const result = await transport.exec(['qm', 'config', String(vmid)], {
    timeoutMs: 10_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to read the configuration of VM ${vmid}: ${
        result.stderr.trim() || `exit code ${result.exitCode}`
      }`,
    );
  }
  return result.stdout;
}

function diskSize(
  config: string,
  vmid: number,
  diskName: string,
): number | undefined {
  const parsed = parseVmProxmoxConfig(config, vmid);
  return numberValue(
    parsed.disks.find((disk) => disk.name === diskName)?.size_gb,
    'disks.size_gb',
  );
}

function parseUnusedDisk(config: string): string | undefined {
  for (const line of config.split(/\r?\n/)) {
    const match = /^unused\d+:\s*(\S+)/.exec(line.trim());
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function configHasName(config: string, name: string): boolean {
  return config.split(/\r?\n/).some((line) => line.trim() === `name: ${name}`);
}

async function waitForAgent(
  transport: Transport,
  vmid: number,
  options: VmStepOptions,
  signal: AbortSignal,
): Promise<void> {
  const attempts = Math.max(1, options.agentAttempts ?? 60);
  const delay = Math.max(0, options.agentDelaySeconds ?? 3);
  let lastError = '';
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    signal.throwIfAborted();
    const ping = await transport.exec(['qm', 'agent', String(vmid), 'ping'], {
      timeoutMs: 10_000,
    });
    if (ping.exitCode === 0) return;
    lastError = ping.stderr.trim() || `exit code ${ping.exitCode}`;
    if (attempt < attempts - 1 && delay > 0) {
      signal.throwIfAborted();
      await transport.exec(['sleep', String(delay)], { timeoutMs: 10_000 });
    }
  }
  throw new Error(
    `VM ${vmid} did not answer the QEMU guest agent after ${attempts} attempts: ${lastError}. Ensure the image has qemu-guest-agent installed and guest_agent: true.`,
  );
}

async function isRunning(transport: Transport, vmid: number): Promise<boolean> {
  const status = await transport.exec(['qm', 'status', String(vmid)], {
    timeoutMs: 10_000,
  });
  return status.exitCode === 0 && /^status:\s*running$/m.test(status.stdout);
}

export function createVmProvisionSteps(
  guest: Vm,
  options: VmStepOptions,
): readonly JournaledStep<undefined>[] {
  const vmid = guest.id;
  const hostId = options.hostId;
  const configPath = vmConfigPath(vmid);
  const expectedStamp = managedGuestUuid(hostId, vmid);
  const createArgv = buildVmCreateArgv(guest, options);
  const configureArgv = buildVmConfigureArgv(guest, options);
  const cloudImage = cloudImageUrl(guest);
  const steps: JournaledStep<undefined>[] = [];

  if (cloudImage) {
    const imagePath = cloudImagePath(vmid, cloudImage);
    const checksum = checksumValue(guest);
    const downloadArgv = cloudImageDownloadArgv(vmid, cloudImage);
    steps.push({
      name: `ensure cloud image for VM ${vmid}`,
      check: async ({ transport }) => {
        const exists = await transport.exec(['test', '-f', imagePath], {
          timeoutMs: 5_000,
        });
        return exists.exitCode === 0
          ? { status: 'satisfied', detail: { image: imagePath } }
          : { status: 'required', detail: { image: imagePath } };
      },
      apply: async ({ transport, logger }) => {
        const result = await transport.exec(downloadArgv, {
          timeoutMs: 1_800_000,
          onOutput: (stream, line) => {
            void logger.info(`cloud image ${stream}: ${line}`);
          },
        });
        if (result.exitCode !== 0) {
          throw new Error(
            `Failed to download cloud image '${cloudImage}': ${
              result.stderr.trim() || `exit code ${result.exitCode}`
            }`,
          );
        }
        return { image: imagePath };
      },
      verify: async ({ transport }) => {
        const exists = await transport.exec(['test', '-f', imagePath], {
          timeoutMs: 5_000,
        });
        if (exists.exitCode !== 0) {
          throw new Error(`Cloud image '${cloudImage}' was not downloaded.`);
        }
        if (checksum) {
          const sum = await transport.exec(['sha256sum', imagePath], {
            timeoutMs: 120_000,
          });
          const actual = sum.stdout.trim().split(/\s+/, 1)[0]?.toLowerCase();
          if (sum.exitCode !== 0 || actual !== checksum) {
            throw new Error(
              `Cloud image '${cloudImage}' failed its sha256 checksum verification.`,
            );
          }
        }
        return { image: imagePath };
      },
      rollbackHint: `Delete '${imagePath}' on ${hostId} and retry the download.`,
    });
  }

  steps.push({
    name: `create VM ${vmid}`,
    check: async ({ transport }) => {
      const exists = await transport.exec(['test', '-f', configPath], {
        timeoutMs: 5_000,
      });
      if (exists.exitCode !== 0) return { status: 'required' };
      const config = await readVmConfig(transport, vmid);
      if (configHasName(config, guest.name)) {
        return {
          status: 'satisfied',
          detail: { vmid, name: guest.name },
        };
      }
      throw new Error(
        `VMID ${vmid} is already occupied by a different workload on host '${hostId}'. Refusing to create over it.`,
      );
    },
    apply: async ({ transport, logger }) => {
      const result = await transport.exec(createArgv, {
        timeoutMs: 600_000,
        onOutput: (stream, line) => {
          void logger.info(
            `qm ${createArgv[1] ?? 'create'} ${stream}: ${line}`,
          );
        },
      });
      if (result.exitCode !== 0) {
        throw new Error(
          `Failed to create VM ${vmid}: ${
            result.stderr.trim() || `exit code ${result.exitCode}`
          }`,
        );
      }
      return { vmid, argv: createArgv };
    },
    verify: async ({ transport }) => {
      const config = await readVmConfig(transport, vmid);
      if (!configHasName(config, guest.name)) {
        throw new Error(
          `VM ${vmid} is missing its name '${guest.name}' after create.`,
        );
      }
      return { vmid, name: guest.name };
    },
    rollbackHint: `Inspect VM ${vmid} on ${hostId}; destroy it only through an explicit confirmed action.`,
  });

  if (cloudImage) {
    const imagePath = cloudImagePath(vmid, cloudImage);
    const first = firstDisk(guest);
    if (!first) {
      throw new Error(
        'Cloud-image VM creation requires at least one disk (for example scsi0).',
      );
    }
    const diskName = first.name;
    const importArgv = buildVmImportArgv(guest, imagePath);
    steps.push({
      name: `import cloud image into VM ${vmid}`,
      check: async ({ transport }) => {
        const config = await readVmConfig(transport, vmid);
        if (new RegExp(`^${diskName}:`, 'm').test(config)) {
          return { status: 'satisfied', detail: { disk: diskName } };
        }
        const unused = parseUnusedDisk(config);
        return {
          status: 'required',
          detail: unused ? { unused } : {},
        };
      },
      apply: async ({ transport, logger }) => {
        const config = await readVmConfig(transport, vmid);
        if (new RegExp(`^${diskName}:`, 'm').test(config)) {
          return { disk: diskName, alreadyAttached: true };
        }
        let volume = parseUnusedDisk(config);
        if (!volume) {
          const imported = await transport.exec(importArgv, {
            timeoutMs: 1_800_000,
            onOutput: (stream, line) => {
              void logger.info(`qm importdisk ${stream}: ${line}`);
            },
          });
          if (imported.exitCode !== 0) {
            throw new Error(
              `Failed to import cloud image for VM ${vmid}: ${
                imported.stderr.trim() || `exit code ${imported.exitCode}`
              }`,
            );
          }
          const match = /unused\d+:\s*([^\s']+)/.exec(imported.stdout);
          volume =
            match?.[1] ??
            `${scalar(firstDisk(guest)?.storage, 'disks[0].storage') ?? 'local-lvm'}:vm-${vmid}-disk-0`;
        }
        const attach = await transport.exec(
          ['qm', 'set', String(vmid), `--${diskName}`, volume],
          { timeoutMs: 60_000 },
        );
        if (attach.exitCode !== 0) {
          throw new Error(
            `Failed to attach the imported disk to VM ${vmid}: ${
              attach.stderr.trim() || `exit code ${attach.exitCode}`
            }`,
          );
        }
        return { disk: diskName, volume };
      },
      verify: async ({ transport }) => {
        const config = await readVmConfig(transport, vmid);
        if (!new RegExp(`^${diskName}:`, 'm').test(config)) {
          throw new Error(
            `VM ${vmid} does not have its imported disk '${diskName}' after import.`,
          );
        }
        return { disk: diskName };
      },
      rollbackHint: `Remove the partially imported disk for VM ${vmid} on ${hostId} before retrying.`,
    });
  }

  steps.push({
    name: `configure VM ${vmid}`,
    check: async ({ transport }) => {
      const config = await readVmConfig(transport, vmid);
      if (
        configHasName(config, guest.name) &&
        config.includes(expectedStamp) &&
        config.includes(MANAGED_GUEST_TAG)
      ) {
        return {
          status: 'satisfied',
          detail: { vmid, stamp: expectedStamp },
        };
      }
      return { status: 'required', detail: { vmid } };
    },
    apply: async ({ transport, logger }) => {
      const result = await transport.exec(configureArgv, {
        timeoutMs: 120_000,
        onOutput: (stream, line) => {
          void logger.info(`qm set ${stream}: ${line}`);
        },
      });
      if (result.exitCode !== 0) {
        throw new Error(
          `Failed to configure VM ${vmid}: ${
            result.stderr.trim() || `exit code ${result.exitCode}`
          }`,
        );
      }
      return { vmid, argv: configureArgv };
    },
    verify: async ({ transport }) => {
      const config = await readVmConfig(transport, vmid);
      if (
        !configHasName(config, guest.name) ||
        !config.includes(expectedStamp) ||
        !config.includes(MANAGED_GUEST_TAG)
      ) {
        throw new Error(
          `VM ${vmid} is missing its name, managed tag or management stamp after configure.`,
        );
      }
      return { vmid, stamp: expectedStamp };
    },
    rollbackHint: `Review 'qm config ${vmid}' on ${hostId} and re-apply the reviewed YAML values manually.`,
  });

  const sizedDisks = guest.disks.filter(
    (disk) => numberValue(disk.size_gb, 'disks.size_gb') !== undefined,
  );
  if (sizedDisks.length > 0) {
    steps.push({
      name: `grow VM ${vmid} disks`,
      check: async ({ transport }) => {
        const config = await readVmConfig(transport, vmid);
        const commands: string[][] = [];
        for (const disk of sizedDisks) {
          const desired = numberValue(disk.size_gb, 'disks.size_gb')!;
          const live = diskSize(config, vmid, disk.name);
          if (live === undefined) {
            throw new Error(
              `VM ${vmid} disk '${disk.name}' is not attached; cannot verify its size.`,
            );
          }
          if (desired < live) {
            throw new Error(
              `Refusing to shrink VM ${vmid} disk '${disk.name}' from ${live} GB to ${desired} GB. Disks only grow.`,
            );
          }
          if (desired > live) {
            commands.push([
              'qm',
              'resize',
              String(vmid),
              disk.name,
              formatSizeGb(desired),
            ]);
          }
        }
        return commands.length > 0
          ? { status: 'required', detail: { commands } }
          : { status: 'satisfied', detail: { disks: sizedDisks.length } };
      },
      apply: async ({ transport }) => {
        const config = await readVmConfig(transport, vmid);
        const commands: string[][] = [];
        for (const disk of sizedDisks) {
          const desired = numberValue(disk.size_gb, 'disks.size_gb')!;
          const live = diskSize(config, vmid, disk.name);
          if (live === undefined) {
            throw new Error(
              `VM ${vmid} disk '${disk.name}' is not attached; cannot resize it.`,
            );
          }
          if (desired < live) {
            throw new Error(
              `Refusing to shrink VM ${vmid} disk '${disk.name}' from ${live} GB to ${desired} GB. Disks only grow.`,
            );
          }
          if (desired > live) {
            const argv = [
              'qm',
              'resize',
              String(vmid),
              disk.name,
              formatSizeGb(desired),
            ];
            const result = await transport.exec(argv, { timeoutMs: 300_000 });
            if (result.exitCode !== 0) {
              throw new Error(
                `Failed to grow VM ${vmid} disk '${disk.name}': ${
                  result.stderr.trim() || `exit code ${result.exitCode}`
                }`,
              );
            }
            commands.push(argv);
          }
        }
        return { vmid, commands };
      },
      verify: async ({ transport }) => {
        const config = await readVmConfig(transport, vmid);
        const sizes: Record<string, number> = {};
        for (const disk of sizedDisks) {
          const desired = numberValue(disk.size_gb, 'disks.size_gb')!;
          const live = diskSize(config, vmid, disk.name);
          if (live === undefined) {
            throw new Error(
              `VM ${vmid} disk '${disk.name}' is not attached after resize.`,
            );
          }
          if (live < desired) {
            throw new Error(
              `VM ${vmid} disk '${disk.name}' is still ${live} GB after growing to ${desired} GB.`,
            );
          }
          sizes[disk.name] = live;
        }
        return { vmid, sizes };
      },
      rollbackHint: `Disk growth cannot be undone automatically. Check 'qm config ${vmid}' on ${hostId} before retrying.`,
    });
  }

  if (guest.guest_agent) {
    steps.push({
      name: `start VM ${vmid} and wait for the guest agent`,
      check: async ({ transport, signal }) => {
        if (!(await isRunning(transport, vmid))) {
          return { status: 'required', detail: { status: 'stopped' } };
        }
        signal.throwIfAborted();
        const ping = await transport.exec(
          ['qm', 'agent', String(vmid), 'ping'],
          { timeoutMs: 10_000 },
        );
        return ping.exitCode === 0
          ? { status: 'satisfied', detail: { status: 'running' } }
          : { status: 'required', detail: { status: 'running', agent: false } };
      },
      apply: async ({ transport, signal }) => {
        if (!(await isRunning(transport, vmid))) {
          const started = await transport.exec(['qm', 'start', String(vmid)], {
            timeoutMs: 120_000,
          });
          if (started.exitCode !== 0) {
            throw new Error(
              `Failed to start VM ${vmid}: ${
                started.stderr.trim() || `exit code ${started.exitCode}`
              }`,
            );
          }
        }
        await waitForAgent(transport, vmid, options, signal);
        return { vmid, agent: true };
      },
      verify: async ({ transport, signal }) => {
        if (!(await isRunning(transport, vmid))) {
          throw new Error(`VM ${vmid} is not running after create.`);
        }
        await waitForAgent(transport, vmid, options, signal);
        return { vmid, agent: true };
      },
      rollbackHint: `Start VM ${vmid} on ${hostId} manually and check that qemu-guest-agent is installed and running.`,
    });
  }

  return steps;
}

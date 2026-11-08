import { z } from 'zod';
import {
  absolutePath,
  extraField,
  schemaVersionField,
  tagged,
  taggedBool,
  taggedInt,
  taggedString,
  toLayerShape,
  vmid,
} from './common.js';

const cidr = z
  .string()
  .regex(
    /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/,
    'Expected CIDR such as 192.0.2.10/24',
  );
const ip = z.union([z.literal('dhcp'), z.literal('manual'), cidr]);
const mac = z
  .string()
  .regex(/^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/, 'Expected a MAC address');

export const diskSchema = z.strictObject({
  name: z
    .string()
    .regex(/^[a-z]+\d*$/, 'Expected a disk key such as rootfs or scsi0')
    .describe('Proxmox disk key (rootfs, scsi0, ...).'),
  storage: taggedString.describe('Proxmox storage ID.'),
  size_gb: tagged(z.number().positive()).describe(
    'Size in GB. Disks only grow, never shrink.',
  ),
  extra: extraField.optional(),
});

export const mountSchema = z.strictObject({
  index: z
    .number()
    .int()
    .min(0)
    .max(255)
    .default(0)
    .describe('mpN index; mp0 is special.'),
  host_path: absolutePath.describe('Directory on the host.'),
  guest_path: absolutePath.describe('Mount point inside the guest.'),
  backup: z.boolean().optional(),
  readonly: z.boolean().optional(),
  permissions: z
    .enum(['minimal', 'world_writable'])
    .default('minimal')
    .describe('world_writable (2777 + default ACLs) is an explicit opt-in.'),
});

export const networkSchema = z.strictObject({
  index: z.number().int().min(0).max(31).describe('netN index.'),
  name: z.string().min(1).optional().describe('Interface name inside an LXC.'),
  bridge: taggedString.optional(),
  ip: tagged(ip).optional(),
  gateway: tagged(z.string().min(1)).optional(),
  mac: tagged(mac).optional(),
  vlan: tagged(z.number().int().min(1).max(4094)).optional(),
  mtu: tagged(z.number().int().min(68).max(65535)).optional(),
  firewall: taggedBool.optional(),
  ipv6: z.enum(['auto', 'dhcp', 'static', 'disabled']).optional(),
  ip6: tagged(z.string().min(1)).optional(),
  gateway6: tagged(z.string().min(1)).optional(),
  extra: extraField.optional(),
});

export const sshSchema = z.strictObject({
  enabled: taggedBool.optional(),
  port: taggedInt.optional(),
  username: taggedString.optional(),
  password: taggedString.optional(),
  authorized_keys: z.array(taggedString).optional(),
});

const lxcFeatures = z.strictObject({
  nesting: z.boolean().optional(),
  keyctl: z.boolean().optional(),
  fuse: z.boolean().optional(),
  mount: z.array(z.string().min(1)).optional(),
});

export const installationSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('template'), template: taggedString }),
  z.strictObject({
    type: z.literal('community_script'),
    url: z
      .url()
      .describe('Admin-only. Must be pinned by commit or hash (D-41).'),
    pinned_commit: z
      .string()
      .regex(/^[0-9a-f]{7,40}$/)
      .optional(),
    content_hash: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/)
      .optional(),
    answers: z.record(z.string(), z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  }),
  z.strictObject({
    type: z.literal('clone'),
    template_id: vmid,
    full: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal('cloud_image'),
    url: z.url(),
    checksum: z.string().min(1).optional(),
  }),
]);

/** Fields shared by LXC and VM; required in a merged (final) deployment. */
const commonShape = {
  cpu: taggedInt.describe('Cores.'),
  ram: taggedInt.describe('Memory in MB.'),
  disks: z.array(diskSchema),
  network: z.array(networkSchema),
  mounts: z.array(mountSchema).optional(),
  tags: z.array(z.string().min(1)).optional(),
  protection: taggedBool
    .optional()
    .describe('Blocks deletion and destructive changes.'),
  ssh: sshSchema.optional(),
  installation: installationSchema.optional(),
  identity_checks: z.array(z.string().min(1)).optional(),
  update_commands: z.array(z.string().min(1)).optional(),
  backup_skip: z.boolean().optional(),
  backup_storage: z.string().min(1).optional(),
  extra: extraField.optional(),
};

const lxcShape = {
  unprivileged: z.boolean().optional(),
  swap: taggedInt.optional(),
  features: lxcFeatures.optional(),
  ostype: z.string().min(1).optional(),
};

const vmShape = {
  bios: z.enum(['seabios', 'ovmf']).optional(),
  machine: z.string().min(1).optional(),
  efi_disk: z.boolean().optional(),
  tpm: z.boolean().optional(),
  guest_agent: z.boolean().optional(),
  cloud_init: z
    .strictObject({
      user: taggedString.optional(),
      password: taggedString.optional(),
      ssh_keys: z.array(taggedString).optional(),
    })
    .optional(),
};

const identity = (type: 'lxc' | 'vm') => ({
  id: vmid.describe('VMID.'),
  name: z.string().min(1).describe('Guest name (not "node").'),
  type: z.literal(type),
});

/** A fully merged guest: what the reconciler consumes. */
export const guestDeploymentSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...identity('lxc'), ...commonShape, ...lxcShape }),
  z.strictObject({ ...identity('vm'), ...commonShape, ...vmShape }),
]);

/** One guest `deployment.yaml` before inheritance: only identity is required. */
export const guestDeploymentFileSchema = z.discriminatedUnion('type', [
  z.strictObject({
    schema_version: schemaVersionField,
    ...identity('lxc'),
    ...toLayerShape(commonShape),
    ...toLayerShape(lxcShape),
  }),
  z.strictObject({
    schema_version: schemaVersionField,
    ...identity('vm'),
    ...toLayerShape(commonShape),
    ...toLayerShape(vmShape),
  }),
]);

/** `default-deployment.yaml`: shared settings, no identity. */
export const deploymentDefaultsFileSchema = z.strictObject({
  schema_version: schemaVersionField,
  ...toLayerShape(commonShape),
  ...toLayerShape(lxcShape),
  ...toLayerShape(vmShape),
});

export type GuestDeployment = z.infer<typeof guestDeploymentSchema>;
export type GuestDeploymentFile = z.infer<typeof guestDeploymentFileSchema>;
export type DeploymentDefaultsFile = z.infer<
  typeof deploymentDefaultsFileSchema
>;

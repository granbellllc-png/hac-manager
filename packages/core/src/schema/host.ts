import { z } from 'zod';
import {
  includable,
  relativePath,
  schemaVersionField,
  taggedInt,
  taggedString,
  vmid,
} from './common.js';

const sshConnection = z.strictObject({
  host: taggedString,
  port: z.number().int().min(1).max(65535).default(22),
  username: taggedString.default('root'),
  private_key: taggedString.optional(),
  password: taggedString.optional(),
  fingerprint: z
    .string()
    .min(1)
    .optional()
    .describe('Pinned SSH host key fingerprint (D-24).'),
});

const apiConnection = z.strictObject({
  url: z.url(),
  token_id: taggedString,
  token_secret: taggedString,
  ca_file: taggedString.optional(),
  fingerprint: z
    .string()
    .min(1)
    .optional()
    .describe('Pinned TLS certificate fingerprint.'),
});

export const ignoredGuestSchema = z.strictObject({
  vmid,
  name: z.string().min(1),
  fingerprint: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Extra identity (creation info) so a reused VMID is not silently ignored (D-62).',
    ),
});

export const driftScheduleSchema = z.strictObject({
  enabled: z.boolean().default(true),
  cron: z
    .string()
    .min(9)
    .max(100)
    .describe(
      'Five-field UTC cron expression for scheduled drift checks (D-34).',
    ),
});

export const hostFileSchema = z.strictObject({
  schema_version: schemaVersionField,
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lowercase letters, digits and dashes'),
  name: z.string().min(1),
  type: z.literal('proxmox'),
  index: taggedInt
    .refine(
      (value) => typeof value !== 'number' || (value >= 0 && value <= 99),
      {
        message: 'host.index must be between 0 and 99',
      },
    )
    .describe('Host index used by helpers such as mac() (0 to 99).'),
  connection: z.strictObject({
    ssh: sshConnection,
    api: apiConnection.optional(),
  }),
  defaults: z
    .strictObject({
      deployment: relativePath.optional(),
      filemappings: relativePath.optional(),
    })
    .optional()
    .describe(
      'Override the default-deployment/default-filemappings file names.',
    ),
  ignored_guests: includable(z.array(ignoredGuestSchema)).default([]),
  groups: z
    .array(z.string().min(1))
    .optional()
    .describe('Groups used by Tier-1 tasks to target this host (D-51).'),
  tags: z
    .array(z.string().min(1))
    .optional()
    .describe('Tags used by Tier-1 tasks to target this host (D-51).'),
  drift_schedule: driftScheduleSchema.optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
});

export type HostFile = z.infer<typeof hostFileSchema>;

import { z } from 'zod';
import {
  absolutePath,
  octalMode,
  tagged,
  taggedInt,
  taggedString,
} from './common.js';

const cronExpression = z
  .string()
  .regex(/^\S+(?:\s+\S+){4}$/, 'Expected a five-field cron expression');

/**
 * `/etc/vzdump.conf` keys. Values may be tagged; a resolved secret is rejected
 * when the file is rendered so credentials never land in a managed file.
 */
export const vzdumpBackupConfigSchema = z.strictObject({
  enabled: z.boolean().default(true),
  path: absolutePath.default('/etc/vzdump.conf'),
  mode: octalMode.default('0644'),
  options: z
    .record(
      z.string().min(1),
      tagged(z.union([z.string(), z.number(), z.boolean()])),
    )
    .default({})
    .describe('Key/value pairs rendered as sorted `key: value` lines.'),
});

/**
 * Host-level restic backup. Credentials stay in root-only files referenced by
 * absolute paths; tagged values that resolve to a `Secret` are refused when a
 * file is rendered (AGENTS.md rule 1).
 */
export const resticBackupConfigSchema = z
  .strictObject({
    enabled: z.boolean().default(true),
    script_path: absolutePath.default('/usr/local/sbin/hacm-restic-backup'),
    cron_path: absolutePath.default('/etc/cron.d/hacm-restic'),
    schedule: cronExpression.default('30 2 * * *'),
    repository: taggedString.optional(),
    repository_file: absolutePath.optional(),
    password_file: absolutePath,
    paths: z.array(absolutePath).min(1),
    excludes: z.array(z.string().min(1)).default([]),
    tag: taggedString.optional(),
    keep_last: taggedInt.optional(),
    keep_daily: taggedInt.optional(),
    keep_weekly: taggedInt.optional(),
    keep_monthly: taggedInt.optional(),
    prune: z.boolean().default(true),
    status_file: absolutePath.default('/var/lib/hacm/restic-status'),
  })
  .refine(
    (value) =>
      (value.repository === undefined) !==
      (value.repository_file === undefined),
    {
      message:
        'Set exactly one of restic.repository or restic.repository_file.',
      path: ['repository'],
    },
  );

export const hostBackupConfigSchema = z.strictObject({
  vzdump: vzdumpBackupConfigSchema.optional(),
  restic: resticBackupConfigSchema.optional(),
});

export type VzdumpBackupConfig = z.infer<typeof vzdumpBackupConfigSchema>;
export type ResticBackupConfig = z.infer<typeof resticBackupConfigSchema>;
export type HostBackupConfig = z.infer<typeof hostBackupConfigSchema>;

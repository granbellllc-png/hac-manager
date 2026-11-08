import { z } from 'zod';
import {
  includable,
  schemaVersionField,
  taggedBool,
  taggedInt,
  taggedString,
} from './common.js';

export const taskSchema = z.strictObject({
  name: z.string().min(1),
  run: z
    .string()
    .min(1)
    .describe('Script sent on stdin; never nested in bash -c.'),
  when: taggedString.optional().describe('Condition, usually an !expr.'),
  creates: z
    .string()
    .min(1)
    .optional()
    .describe('Skip when this path exists (idempotency).'),
  timeout: taggedInt.optional().describe('Seconds.'),
  retries: taggedInt.optional(),
  ignore_errors: taggedBool.optional(),
  onchange: z
    .array(z.string().min(1))
    .optional()
    .describe('Task names to trigger.'),
  env: z.record(z.string(), taggedString).optional(),
  shell: z.string().min(1).optional().describe('Interpreter, for example sh.'),
});

export const tasksFileSchema = z.strictObject({
  schema_version: schemaVersionField,
  targets: z
    .strictObject({
      groups: z.array(z.string().min(1)).optional(),
      tags: z.array(z.string().min(1)).optional(),
    })
    .optional()
    .describe('Tier 1 only: select hosts by group or tag.'),
  tasks: z.array(includable(taskSchema)),
});

export type TasksFile = z.infer<typeof tasksFileSchema>;

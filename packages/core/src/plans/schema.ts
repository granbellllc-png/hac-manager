import { z } from 'zod';
import type { MutationPlan } from './types.js';

export const planTargetSchema = z.strictObject({
  hostId: z.string().min(1),
  vmid: z.number().int().optional(),
  resourceType: z.enum(['host', 'guest', 'file']).optional(),
});

export const planChangeSchema = z.strictObject({
  id: z.string().min(1),
  action: z.enum(['create', 'update', 'delete', 'execute']),
  summary: z.string().min(1),
  path: z.string().optional(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  warnings: z.array(z.string()).optional(),
  destructive: z.boolean().optional(),
});

export const mutationPlanSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  operation: z.string().min(1),
  target: planTargetSchema,
  summary: z.string().min(1),
  changes: z.array(planChangeSchema).min(1),
  warnings: z.array(z.string()),
  destructive: z.boolean(),
  stateFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  confirmationText: z.string().min(1).optional(),
  createdAt: z.iso.datetime(),
});

export function parseMutationPlan(value: unknown): MutationPlan {
  return mutationPlanSchema.parse(value) as MutationPlan;
}

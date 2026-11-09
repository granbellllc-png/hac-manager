import { createHash } from 'node:crypto';
import { Secret } from '../tags/secret.js';
import { PlanValidationError } from './types.js';

function canonicalize(value: unknown, active: WeakSet<object>): unknown {
  if (value instanceof Secret) {
    return { $secretHash: value.hash };
  }
  if (value instanceof Date) {
    return { $date: value.toISOString() };
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new PlanValidationError(
        'Plan state cannot contain non-finite numbers',
      );
    }
    return value;
  }
  if (value === undefined) return { $undefined: true };
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  if (typeof value !== 'object') {
    throw new PlanValidationError(
      `Plan state cannot contain values of type '${typeof value}'`,
    );
  }
  if (active.has(value)) {
    throw new PlanValidationError('Plan state cannot contain reference cycles');
  }

  active.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => canonicalize(item, active));
    }

    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      result[key] = canonicalize(source[key], active);
    }
    return result;
  } finally {
    active.delete(value);
  }
}

export function fingerprintPlanState(state: unknown): string {
  const canonical = canonicalize(state, new WeakSet<object>());
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

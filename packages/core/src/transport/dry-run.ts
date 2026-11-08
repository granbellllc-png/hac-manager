import type { Transport } from './types.js';

/**
 * Dry-run contract: every executor receives an `ExecutorContext` and must not
 * mutate anything when `dryRun` is set (AGENTS.md rule 11).
 */
export interface ExecutorContext {
  readonly transport: Transport;
  readonly dryRun: boolean;
}

export type MutationOutcome<T> =
  | { readonly status: 'applied'; readonly value: T }
  | { readonly status: 'skipped'; readonly description: string };

/**
 * Runs `mutate` only when the context is not a dry run. Executors wrap every
 * mutating call (exec of a changing command, writeFile) with this helper.
 */
export async function runMutation<T>(
  context: ExecutorContext,
  description: string,
  mutate: (transport: Transport) => Promise<T>,
): Promise<MutationOutcome<T>> {
  if (context.dryRun) return { status: 'skipped', description };
  return { status: 'applied', value: await mutate(context.transport) };
}

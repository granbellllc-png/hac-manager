import type { z } from 'zod';
import { migrateDocument } from './migrate.js';
import { configSchemas, type ConfigKind, type ConfigOf } from './registry.js';

export interface ConfigIssue {
  /** Dotted path such as `network.0.ip`; empty for the document root. */
  readonly path: string;
  readonly message: string;
  readonly code: string;
}

export type ParseResult<K extends ConfigKind> =
  | {
      readonly ok: true;
      readonly value: ConfigOf<K>;
      readonly migrated: boolean;
    }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

/**
 * Flattens zod issues into path-based issues. `invalid_union` hides the real
 * cause inside its branches; every union in the schemas lists the literal
 * (non-tag) shape first, so its branch carries the precise errors.
 */
export function formatIssues(
  issues: readonly z.core.$ZodIssue[],
  prefix: readonly PropertyKey[] = [],
): ConfigIssue[] {
  return issues.flatMap((issue): ConfigIssue[] => {
    const path = [...prefix, ...issue.path];
    if (
      issue.code === 'invalid_union' &&
      issue.errors[0] &&
      issue.errors[0].length > 0
    ) {
      return formatIssues(issue.errors[0], path);
    }
    return [
      {
        path: path.map(String).join('.'),
        message: issue.message,
        code: issue.code,
      },
    ];
  });
}
/** Migrates, then validates a raw document. Never throws for bad input. */
export function parseConfig<K extends ConfigKind>(
  kind: K,
  raw: unknown,
): ParseResult<K> {
  const migration = migrateDocument(kind, raw);
  if (!migration.ok) {
    return {
      ok: false,
      issues: [
        {
          path: 'schema_version',
          message: migration.message,
          code: migration.code,
        },
      ],
    };
  }
  const result = configSchemas[kind].safeParse(migration.document);
  if (!result.success)
    return { ok: false, issues: formatIssues(result.error.issues) };
  return {
    ok: true,
    value: result.data as ConfigOf<K>,
    migrated: migration.migrated,
  };
}

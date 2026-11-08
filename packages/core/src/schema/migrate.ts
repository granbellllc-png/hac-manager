import type { ConfigKind } from './registry.js';
import { currentSchemaVersion } from './common.js';

/** Upgrades a raw document from `schema_version` N to N + 1. */
export type Migration = (
  document: Record<string, unknown>,
) => Record<string, unknown>;

/**
 * Migration hook: `migrations[kind][n]` upgrades version n to n + 1.
 * Empty while version 1 is the only version; add entries when it changes.
 */
export const migrations: Partial<
  Record<ConfigKind, Readonly<Record<number, Migration>>>
> = {};

export type MigrationResult =
  | {
      readonly ok: true;
      readonly document: Record<string, unknown>;
      readonly migrated: boolean;
    }
  | {
      readonly ok: false;
      readonly code:
        'not_an_object' | 'missing_version' | 'unsupported_version';
      readonly message: string;
    };

export function migrateDocument(
  kind: ConfigKind,
  raw: unknown,
  registry: Partial<
    Record<ConfigKind, Readonly<Record<number, Migration>>>
  > = migrations,
  target: number = currentSchemaVersion,
): MigrationResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      code: 'not_an_object',
      message: 'Document must be a YAML mapping.',
    };
  }
  let document = raw as Record<string, unknown>;
  let version = document['schema_version'];
  if (
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 1
  ) {
    return {
      ok: false,
      code: 'missing_version',
      message: 'schema_version is required and must be a positive integer.',
    };
  }
  if (version > target) {
    return {
      ok: false,
      code: 'unsupported_version',
      message: `schema_version ${String(version)} is newer than the supported version ${String(target)}.`,
    };
  }
  const startVersion = version;
  while (version < target) {
    const step = registry[kind]?.[version];
    if (!step) {
      return {
        ok: false,
        code: 'unsupported_version',
        message: `No migration from schema_version ${String(version)}.`,
      };
    }
    document = { ...step(document), schema_version: version + 1 };
    version += 1;
  }
  return { ok: true, document, migrated: version !== startVersion };
}

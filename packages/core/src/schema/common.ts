import { z } from 'zod';

/** Current `schema_version` of every config file kind. */
export const currentSchemaVersion = 1;
export const schemaVersionField = z
  .literal(currentSchemaVersion)
  .describe('Schema version of this file.');

export const tagNames = ['env', 'secret', 'cmd', 'expr', 'include'] as const;
export type TagName = (typeof tagNames)[number];

/**
 * A YAML custom tag (`!env X`, `!secret x`, `!cmd "..."`, `!expr "..."`,
 * `!include path`) as produced by the YAML loader. Tags are resolved later,
 * after merging; schemas only check that a tagged value is well-formed.
 */
export interface TagValue {
  readonly tag: TagName;
  readonly value: string;
}

export const tagValueSchema = z
  .strictObject({ tag: z.enum(tagNames), value: z.string().min(1) })
  .meta({ hacmKind: 'tag' });

export function isTagValue(value: unknown): value is TagValue {
  return tagValueSchema.safeParse(value).success;
}

/** A scalar that may be a literal or a tagged (computed) value. */
export function tagged<T extends z.ZodType>(inner: T) {
  return z.union([inner, tagValueSchema]);
}

/** A list item or file section that may be replaced by an `!include`. */
export function includable<T extends z.ZodType>(inner: T) {
  return z.union([inner, tagValueSchema]);
}

export const taggedString = tagged(z.string().min(1));
export const taggedInt = tagged(z.number().int());
export const taggedBool = tagged(z.boolean());

/** Proxmox keys we do not model are kept here, untouched (D-03). */
export const extraField = z
  .record(z.string(), z.unknown())
  .describe('Proxmox keys that HAC Manager does not model; preserved as-is.');

/**
 * Makes every field of a shape optional and clearable with an explicit
 * `null` (D-06): the form used by files that are merged onto defaults.
 */
export function toLayerShape<S extends Record<string, z.ZodType>>(
  shape: S,
): { [K in keyof S]: z.ZodOptional<z.ZodNullable<S[K]>> } {
  return Object.fromEntries(
    Object.entries(shape).map(([key, field]) => [
      key,
      field.nullable().optional(),
    ]),
  ) as { [K in keyof S]: z.ZodOptional<z.ZodNullable<S[K]>> };
}

export const octalMode = z
  .string()
  .regex(/^[0-7]{3,4}$/, 'Expected an octal mode such as "0644"');
export const absolutePath = z
  .string()
  .regex(/^\//, 'Expected an absolute path')
  .refine(
    (path) => !path.split('/').includes('..'),
    'Path must not contain ".."',
  );
export const relativePath = z
  .string()
  .min(1)
  .refine(
    (path) => !path.startsWith('/') && !path.split('/').includes('..'),
    'Expected a relative path inside the data dir without ".."',
  );
export const vmid = z.number().int().min(100).max(999_999_999);

import { z } from 'zod';
import { configKinds, configSchemas, type ConfigKind } from './registry.js';

export type JsonSchema = Record<string, unknown>;

/**
 * JSON Schema for editors (yaml-language-server). YAML tags are not JSON, so a
 * tagged scalar is described as a string, which is what editors see.
 */
export function toEditorJsonSchema(kind: ConfigKind): JsonSchema {
  return z.toJSONSchema(configSchemas[kind], {
    target: 'draft-2020-12',
    io: 'input',
    unrepresentable: 'any',
    override: (context) => {
      const meta = z.globalRegistry.get(context.zodSchema) as
        { hacmKind?: string } | undefined;
      if (meta?.hacmKind === 'tag') {
        const schema = context.jsonSchema as Record<string, unknown>;
        for (const key of Object.keys(schema)) delete schema[key];
        schema['type'] = 'string';
        schema['description'] =
          'Tagged value (!env, !secret, !cmd, !expr or !include).';
      }
    },
  }) as JsonSchema;
}

export function allEditorJsonSchemas(): Record<ConfigKind, JsonSchema> {
  return Object.fromEntries(
    configKinds.map((kind) => [kind, toEditorJsonSchema(kind)]),
  ) as Record<ConfigKind, JsonSchema>;
}

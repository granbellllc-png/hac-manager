import { z } from 'zod';
import { schemaVersionField } from './common.js';

/** Plaintext values live only in the gitignored `secrets.yaml` (D-12). */
export const secretsFileSchema = z.strictObject({
  schema_version: schemaVersionField,
  values: z.record(z.string().min(1), z.string()),
});

export type SecretsFile = z.infer<typeof secretsFileSchema>;

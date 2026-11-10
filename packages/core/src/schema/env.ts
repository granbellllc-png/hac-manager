import { z } from 'zod';
import { schemaVersionField, tagged } from './common.js';

/** POSIX environment variable names; dots and dashes stay out of `.env` files. */
export const envVariableName = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    'Expected an environment variable name such as APP_PORT',
  )
  .describe('Environment variable name.');

/**
 * A tracked `.env.yaml` next to a guest folder (D-18). Values are strings or
 * tags; tags are resolved only when the file is rendered, never written back.
 */
export const envFileSchema = z.strictObject({
  schema_version: schemaVersionField,
  values: z
    .record(envVariableName, tagged(z.string()))
    .describe('Environment variables rendered into the guest `.env` file.'),
});

export type EnvFile = z.infer<typeof envFileSchema>;

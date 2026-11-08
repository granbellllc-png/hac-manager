import { z } from 'zod';
import {
  includable,
  absolutePath,
  octalMode,
  relativePath,
  schemaVersionField,
  taggedString,
} from './common.js';

const conflictPolicy = z
  .enum(['overwrite', 'skip', 'fetch', 'prompt'])
  .describe('What to do when the remote file changed (D-50).');

const fileLike = {
  source: relativePath.describe('Path inside the guest folder or data dir.'),
  destination: absolutePath.describe('Absolute path in the guest.'),
  mode: octalMode.optional(),
  owner: taggedString.optional(),
  group: taggedString.optional(),
  conflict: conflictPolicy.default('prompt'),
};

export const mappingSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('file'), ...fileLike }),
  z.strictObject({
    type: z.literal('archive'),
    ...fileLike,
    source: relativePath.regex(
      /\.(zip|tar\.gz|tgz|tar\.bz2|tar\.xz)$/,
      'Expected .zip, .tar.gz, .tgz, .tar.bz2 or .tar.xz',
    ),
  }),
  z.strictObject({
    type: z.literal('directory'),
    ...fileLike,
    method: z.enum(['tar', 'rsync']).default('tar'),
    delete: z
      .boolean()
      .default(false)
      .describe('Remove files not present in the source.'),
  }),
  z.strictObject({ type: z.literal('template'), ...fileLike }),
]);

export const filemappingsFileSchema = z.strictObject({
  schema_version: schemaVersionField,
  mappings: z.array(includable(mappingSchema)),
});

export type FilemappingsFile = z.infer<typeof filemappingsFileSchema>;

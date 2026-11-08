import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { allEditorJsonSchemas, renderConfigReference } from '../src/index.js';

const outDir = resolve(import.meta.dirname, '../dist/schemas');
mkdirSync(outDir, { recursive: true });
for (const [kind, schema] of Object.entries(allEditorJsonSchemas())) {
  writeFileSync(
    resolve(outDir, `${kind}.schema.json`),
    `${JSON.stringify(schema, null, 2)}\n`,
  );
}
if (process.argv.includes('--docs')) {
  const docs = resolve(
    import.meta.dirname,
    '../../../docs/reference/config.md',
  );
  mkdirSync(resolve(docs, '..'), { recursive: true });
  writeFileSync(docs, `${renderConfigReference()}\n`);
}

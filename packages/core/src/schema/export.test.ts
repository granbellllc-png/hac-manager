import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportSchemas, renderModelineDocs } from './export.js';
import { allEditorJsonSchemas } from './json-schema.js';

let directory: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('schema artifacts', () => {
  it('exports every schema and the generated reference from the canonical zod definitions', async () => {
    directory = await mkdtemp(join(tmpdir(), 'hacm-schema-export-'));
    const outDir = join(directory, 'build', 'schemas');
    const result = exportSchemas({ outDir, docs: true });
    const schemas = allEditorJsonSchemas();
    expect(result.exportedFiles).toHaveLength(Object.keys(schemas).length);
    for (const [kind, schema] of Object.entries(schemas)) {
      expect(
        JSON.parse(await readFile(join(outDir, `${kind}.schema.json`), 'utf8')),
      ).toEqual(schema);
    }
    expect(
      await readFile(join(directory, 'docs/reference/config.md'), 'utf8'),
    ).toContain('Configuration reference');
    expect(result.modelineDocs).toContain('yaml.schemas');
    vi.spyOn(process, 'cwd').mockReturnValue(directory);
    expect(exportSchemas().outDir).toBe(join(directory, 'schemas'));
    expect(renderModelineDocs()).toContain('./schemas/secrets.schema.json');
  });
});

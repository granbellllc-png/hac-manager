import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { allEditorJsonSchemas } from './json-schema.js';
import { renderConfigReference } from './reference.js';

export interface SchemaExportOptions {
  readonly outDir?: string | undefined;
  readonly docs?: boolean | undefined;
}

export interface SchemaExportResult {
  readonly outDir: string;
  readonly exportedFiles: readonly string[];
  readonly modelineDocs: string;
}

export function renderModelineDocs(schemaDir = 'schemas'): string {
  return [
    '# yaml-language-server modeline documentation',
    '',
    'Add this comment to the top of your YAML files to enable editor validation and autocompletion:',
    '',
    '  # yaml-language-server: $schema=<relative-or-absolute-path-to-schema>',
    '',
    'Examples:',
    `  hosts/<host>/host.yaml:`,
    `    # yaml-language-server: $schema=../../${schemaDir}/host.schema.json`,
    '',
    `  hosts/<host>/default-deployment.yaml:`,
    `    # yaml-language-server: $schema=../../${schemaDir}/deployment-defaults.schema.json`,
    '',
    `  hosts/<host>/<vmid>-<name>/deployment.yaml:`,
    `    # yaml-language-server: $schema=../../../${schemaDir}/deployment.schema.json`,
    '',
    `  hosts/<host>/<vmid>-<name>/filemappings.yaml:`,
    `    # yaml-language-server: $schema=../../../${schemaDir}/filemappings.schema.json`,
    '',
    `  tasks/*.yaml or global-tasks/*.yaml:`,
    `    # yaml-language-server: $schema=../${schemaDir}/tasks.schema.json`,
    '',
    `  secrets.yaml:`,
    `    # yaml-language-server: $schema=./${schemaDir}/secrets.schema.json`,
    '',
    'Alternatively, configure VS Code settings (.vscode/settings.json):',
    '{',
    '  "yaml.schemas": {',
    `    "./${schemaDir}/host.schema.json": "hosts/*/host.yaml",`,
    `    "./${schemaDir}/deployment-defaults.schema.json": "hosts/*/default-deployment.yaml",`,
    `    "./${schemaDir}/deployment.schema.json": "hosts/*/*/deployment.yaml",`,
    `    "./${schemaDir}/filemappings.schema.json": ["hosts/*/default-filemappings.yaml", "hosts/*/*/filemappings.yaml"],`,
    `    "./${schemaDir}/tasks.schema.json": ["global-tasks/*.yaml", "hosts/*/tasks/*.yaml", "hosts/*/*/tasks/*.yaml"],`,
    `    "./${schemaDir}/secrets.schema.json": "secrets.yaml"`,
    '  }',
    '}',
  ].join('\n');
}

export function exportSchemas(
  options: SchemaExportOptions = {},
): SchemaExportResult {
  const outDir = resolve(options.outDir ?? 'schemas');
  mkdirSync(outDir, { recursive: true });

  const schemas = allEditorJsonSchemas();
  const exportedFiles: string[] = [];

  for (const [kind, schema] of Object.entries(schemas)) {
    const filePath = resolve(outDir, `${kind}.schema.json`);
    writeFileSync(filePath, `${JSON.stringify(schema, null, 2)}\n`);
    exportedFiles.push(filePath);
  }

  if (options.docs) {
    const docs = resolve(outDir, '../../docs/reference/config.md');
    mkdirSync(dirname(docs), { recursive: true });
    writeFileSync(docs, `${renderConfigReference()}\n`);
  }

  const displayDir = options.outDir
    ? options.outDir.replaceAll('\\', '/').replace(/^\.\//, '')
    : 'schemas';

  return {
    outDir,
    exportedFiles,
    modelineDocs: renderModelineDocs(displayDir),
  };
}

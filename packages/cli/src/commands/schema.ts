import { resolve } from 'node:path';
import { exportSchemas } from '@hacm/core';

export interface CliSchemaExportOptions {
  readonly outDir?: string | undefined;
  readonly json?: boolean | undefined;
  readonly docs?: boolean | undefined;
}

export async function runSchemaExport(
  options: CliSchemaExportOptions = {},
): Promise<number> {
  const outDir = resolve(options.outDir ?? './schemas');
  const result = exportSchemas({
    outDir,
    docs: options.docs ?? false,
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(
    `Exported ${result.exportedFiles.length} JSON Schemas to ${result.outDir}\n\n`,
  );
  process.stdout.write(`${result.modelineDocs}\n`);
  return 0;
}

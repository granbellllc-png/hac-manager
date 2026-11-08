import { resolve } from 'node:path';
import { validateDataDir } from '@hacm/core';

export interface CliValidateOptions {
  readonly dataDir?: string | undefined;
  readonly json?: boolean | undefined;
  readonly resolve?: boolean | undefined;
}

export async function runValidate(
  options: CliValidateOptions = {},
): Promise<number> {
  const dataDir = resolve(
    options.dataDir ?? process.env.HACM_DATA_DIR ?? process.cwd(),
  );

  const result = await validateDataDir({
    dataDir,
    resolve: options.resolve ?? false,
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.valid ? 0 : 1;
  }

  if (result.issues.length > 0) {
    for (const issue of result.issues) {
      const loc =
        issue.line !== undefined
          ? `${issue.file}:${issue.line}${issue.column !== undefined ? `:${issue.column}` : ''}`
          : issue.file;
      const prefix = issue.severity === 'error' ? 'error' : 'warning';
      const pathSuffix = issue.path ? ` [${issue.path}]` : '';
      process.stderr.write(
        `${loc}: ${prefix}: ${issue.message}${pathSuffix}\n`,
      );
    }
  }

  if (result.valid) {
    process.stdout.write(
      `✓ Validation passed: ${result.stats.hosts} host(s), ${result.stats.guests} guest(s), ${result.stats.files} file(s) checked.\n`,
    );
    return 0;
  }

  const errorCount = result.issues.filter((i) => i.severity === 'error').length;
  process.stderr.write(`✗ Validation failed with ${errorCount} error(s).\n`);
  return 1;
}

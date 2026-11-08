import { resolve } from 'node:path';
import { initDataDir } from '@hacm/core';

export interface CliInitOptions {
  readonly dataDir?: string | undefined;
  readonly host?: string | undefined;
  readonly hostName?: string | undefined;
  readonly hostIp?: string | undefined;
  readonly json?: boolean | undefined;
}

export async function runInit(options: CliInitOptions = {}): Promise<number> {
  const dataDir = resolve(
    options.dataDir ?? process.env.HACM_DATA_DIR ?? process.cwd(),
  );

  const result = await initDataDir({
    dataDir,
    hostId: options.host,
    hostName: options.hostName,
    hostIp: options.hostIp,
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(
    `Scaffolded HAC Manager data directory at ${result.dataDir}\n`,
  );
  for (const action of result.actions) {
    if (action.status === 'created') {
      process.stdout.write(`  created: ${action.path}\n`);
    } else {
      process.stdout.write(`  skipped (already exists): ${action.path}\n`);
    }
  }

  process.stdout.write(`
Next steps:
  1. Review hosts/${result.hostId}/host.yaml and configure connection settings.
  2. Populate secrets.yaml with credentials (ignored by git).
  3. Run 'hacm validate' to verify the data directory.
`);

  return 0;
}

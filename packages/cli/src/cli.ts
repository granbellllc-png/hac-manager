import { runValidate } from './commands/validate.js';
import { runSchemaExport } from './commands/schema.js';

export function printHelp(): void {
  process.stdout.write(`hacm - Homelab as Code Manager CLI

Usage:
  hacm <command> [options]

Commands:
  validate                 Validate data directory schemas, merge, tags and layout
  schema export            Export JSON Schemas and document yaml-language-server modeline

Validate Options:
  -d, --data-dir <path>    Path to data directory (defaults to HACM_DATA_DIR or current directory)
  --json                   Output machine-readable JSON
  --resolve                Opt-in to resolve secrets, env, and external commands

Schema Export Options:
  -o, --out-dir <path>     Directory to write JSON Schemas to (defaults to ./schemas)
  --json                   Output machine-readable JSON
  --docs                   Also update reference documentation

General Options:
  -h, --help               Display this help text
  -v, --version            Display version information
`);
}

export async function runCli(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
    printHelp();
    return 0;
  }

  if (argv.includes('-v') || argv.includes('--version')) {
    process.stdout.write(`hacm 0.0.0\n`);
    return 0;
  }

  const [command, ...args] = argv;

  if (command === 'validate') {
    let dataDir: string | undefined;
    let json = false;
    let resolve = false;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === '--json') {
        json = true;
      } else if (arg === '--resolve') {
        resolve = true;
      } else if (arg === '-d' || arg === '--data-dir') {
        dataDir = args[++i];
      } else if (arg.startsWith('--data-dir=')) {
        dataDir = arg.slice('--data-dir='.length);
      }
    }

    return runValidate({ dataDir, json, resolve });
  }

  if (command === 'schema') {
    const subCommand = args[0];
    if (subCommand === 'export') {
      const exportArgs = args.slice(1);
      let outDir: string | undefined;
      let json = false;
      let docs = false;

      for (let i = 0; i < exportArgs.length; i++) {
        const arg = exportArgs[i]!;
        if (arg === '--json') {
          json = true;
        } else if (arg === '--docs') {
          docs = true;
        } else if (arg === '-o' || arg === '--out-dir') {
          outDir = exportArgs[++i];
        } else if (arg.startsWith('--out-dir=')) {
          outDir = arg.slice('--out-dir='.length);
        }
      }

      return runSchemaExport({ outDir, json, docs });
    }

    process.stderr.write(
      `Unknown schema command: ${subCommand ?? '(missing)'}\n`,
    );
    printHelp();
    return 1;
  }

  process.stderr.write(`Unknown command: ${command}\n`);
  printHelp();
  return 1;
}

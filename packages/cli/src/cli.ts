import { runInit } from './commands/init.js';
import { runSchemaExport } from './commands/schema.js';
import { runValidate } from './commands/validate.js';
import { runImport } from './commands/import.js';
import { runPlan } from './commands/plan.js';
import { runApply } from './commands/apply.js';
import { runWhoami } from './commands/whoami.js';

export function printHelp(): void {
  process.stdout.write(`hacm - Homelab as Code Manager CLI

Usage:
  hacm <command> [options]

Commands:
  init                     Scaffold a new data directory with layout and gitignore
  validate                 Validate data directory schemas, merge, tags and layout
  schema export            Export JSON Schemas and document yaml-language-server modeline
  import                   Import live guests into YAML deployment files
  plan                     Create a fingerprinted guest-import plan file
  apply                    Verify and apply a saved plan
  whoami                   Verify API-token authentication against a server

Init Options:
  -d, --data-dir <path>    Path to directory to scaffold (defaults to current directory)
  --host <id>              First host identifier (default: pve-01)
  --host-name <name>       First host display name
  --host-ip <ip>           First host IP or hostname (default: 192.0.2.10)
  --json                   Output machine-readable JSON

Validate Options:
  -d, --data-dir <path>    Path to data directory (defaults to HACM_DATA_DIR or current directory)
  --json                   Output machine-readable JSON
  --resolve                Opt-in to resolve secrets, env, and external commands

Import Options:
  -d, --data-dir <path>    Path to data directory (defaults to HACM_DATA_DIR or current directory)
  --host <id>              Host ID to import under (e.g. pve-01)
  --file <path>            Path to Proxmox config file (pct/qm config) or '-' for stdin
  --vmid <number>          VMID to assign to the imported guest
  --type <lxc|vm>          Guest type (auto-detected if omitted)
  --dry-run                Preview generated YAML and plan without writing to disk
  --overwrite              Allow overwriting existing deployment.yaml
  --json                   Output machine-readable JSON

Plan Options:
  -d, --data-dir <path>    Path to data directory
  --host <id>              Host ID to import under
  --file <path>            Path to a Proxmox config file
  --vmid <number>          VMID to assign to the imported guest
  --type <lxc|vm>          Guest type (auto-detected if omitted)
  --overwrite              Plan replacement of an existing deployment.yaml
  -o, --out <path>         Save the reusable plan document
  --json                   Output the complete plan document as JSON

Apply Options:
  -d, --data-dir <path>    Path to data directory
  --plan <path>            Saved plan document to verify and apply
  --dry-run                Run freshness checks without writing
  --confirm <text>         Typed confirmation for destructive plans
  --json                   Output machine-readable JSON

Whoami Options:
  --server <url>           HAC Manager server (defaults to HACM_SERVER_URL)
  --token-env <name>       Environment variable containing the token (default: HACM_API_TOKEN)
  --json                   Output machine-readable JSON

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

  if (command === 'init') {
    let dataDir: string | undefined;
    let host: string | undefined;
    let hostName: string | undefined;
    let hostIp: string | undefined;
    let json = false;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === '--json') {
        json = true;
      } else if (arg === '-d' || arg === '--data-dir') {
        dataDir = args[++i];
      } else if (arg.startsWith('--data-dir=')) {
        dataDir = arg.slice('--data-dir='.length);
      } else if (arg === '--host') {
        host = args[++i];
      } else if (arg.startsWith('--host=')) {
        host = arg.slice('--host='.length);
      } else if (arg === '--host-name') {
        hostName = args[++i];
      } else if (arg.startsWith('--host-name=')) {
        hostName = arg.slice('--host-name='.length);
      } else if (arg === '--host-ip') {
        hostIp = args[++i];
      } else if (arg.startsWith('--host-ip=')) {
        hostIp = arg.slice('--host-ip='.length);
      }
    }

    return runInit({ dataDir, host, hostName, hostIp, json });
  }

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

  if (command === 'import') {
    let dataDir: string | undefined;
    let host: string | undefined;
    let file: string | undefined;
    let vmid: number | undefined;
    let type: 'lxc' | 'vm' | undefined;
    let dryRun = false;
    let overwrite = false;
    let json = false;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === '--json') {
        json = true;
      } else if (arg === '--dry-run') {
        dryRun = true;
      } else if (arg === '--overwrite') {
        overwrite = true;
      } else if (arg === '-d' || arg === '--data-dir') {
        dataDir = args[++i];
      } else if (arg.startsWith('--data-dir=')) {
        dataDir = arg.slice('--data-dir='.length);
      } else if (arg === '--host') {
        host = args[++i];
      } else if (arg.startsWith('--host=')) {
        host = arg.slice('--host='.length);
      } else if (arg === '--file') {
        file = args[++i];
      } else if (arg.startsWith('--file=')) {
        file = arg.slice('--file='.length);
      } else if (arg === '--vmid') {
        vmid = Number(args[++i]);
      } else if (arg.startsWith('--vmid=')) {
        vmid = Number(arg.slice('--vmid='.length));
      } else if (arg === '--type') {
        const t = args[++i];
        if (t === 'lxc' || t === 'vm') type = t;
      } else if (arg.startsWith('--type=')) {
        const t = arg.slice('--type='.length);
        if (t === 'lxc' || t === 'vm') type = t;
      }
    }

    return runImport({
      dataDir,
      host,
      file,
      vmid,
      type,
      dryRun,
      overwrite,
      json,
    });
  }

  if (command === 'plan') {
    let dataDir: string | undefined;
    let host: string | undefined;
    let file: string | undefined;
    let vmid: number | undefined;
    let type: 'lxc' | 'vm' | undefined;
    let overwrite = false;
    let out: string | undefined;
    let json = false;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === '--json') json = true;
      else if (arg === '--overwrite') overwrite = true;
      else if (arg === '-d' || arg === '--data-dir') dataDir = args[++i];
      else if (arg.startsWith('--data-dir='))
        dataDir = arg.slice('--data-dir='.length);
      else if (arg === '--host') host = args[++i];
      else if (arg.startsWith('--host=')) host = arg.slice('--host='.length);
      else if (arg === '--file') file = args[++i];
      else if (arg.startsWith('--file=')) file = arg.slice('--file='.length);
      else if (arg === '--vmid') vmid = Number(args[++i]);
      else if (arg.startsWith('--vmid='))
        vmid = Number(arg.slice('--vmid='.length));
      else if (arg === '--type') {
        const value = args[++i];
        if (value === 'lxc' || value === 'vm') type = value;
      } else if (arg.startsWith('--type=')) {
        const value = arg.slice('--type='.length);
        if (value === 'lxc' || value === 'vm') type = value;
      } else if (arg === '-o' || arg === '--out') out = args[++i];
      else if (arg.startsWith('--out=')) out = arg.slice('--out='.length);
    }
    return runPlan({
      dataDir,
      host,
      file,
      vmid,
      type,
      overwrite,
      out,
      json,
    });
  }

  if (command === 'apply') {
    let dataDir: string | undefined;
    let plan: string | undefined;
    let dryRun = false;
    let confirmation: string | undefined;
    let json = false;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === '--json') json = true;
      else if (arg === '--dry-run') dryRun = true;
      else if (arg === '-d' || arg === '--data-dir') dataDir = args[++i];
      else if (arg.startsWith('--data-dir='))
        dataDir = arg.slice('--data-dir='.length);
      else if (arg === '--plan') plan = args[++i];
      else if (arg.startsWith('--plan=')) plan = arg.slice('--plan='.length);
      else if (arg === '--confirm') confirmation = args[++i];
      else if (arg.startsWith('--confirm='))
        confirmation = arg.slice('--confirm='.length);
    }
    return runApply({ dataDir, plan, dryRun, confirmation, json });
  }

  if (command === 'whoami') {
    let server: string | undefined;
    let tokenEnv: string | undefined;
    let json = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === '--json') json = true;
      else if (arg === '--server') server = args[++i];
      else if (arg.startsWith('--server='))
        server = arg.slice('--server='.length);
      else if (arg === '--token-env') tokenEnv = args[++i];
      else if (arg.startsWith('--token-env='))
        tokenEnv = arg.slice('--token-env='.length);
    }
    return runWhoami({ server, tokenEnv, json });
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

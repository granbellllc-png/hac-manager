import { resolve, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  parseProxmoxConfig,
  planGuestImport,
  applyGuestImport,
  deploymentDefaultsFileSchema,
  loadYamlDocument,
  detectProxmoxConfigType,
} from '@hacm/core';

export interface CliImportOptions {
  readonly dataDir?: string | undefined;
  readonly host?: string | undefined;
  readonly file?: string | undefined;
  readonly vmid?: number | undefined;
  readonly type?: 'lxc' | 'vm' | undefined;
  readonly dryRun?: boolean | undefined;
  readonly overwrite?: boolean | undefined;
  readonly json?: boolean | undefined;
}

export async function runImport(
  options: CliImportOptions = {},
): Promise<number> {
  const dataDir = resolve(
    options.dataDir ?? process.env.HACM_DATA_DIR ?? process.cwd(),
  );

  const hostId = options.host;
  if (!hostId) {
    process.stderr.write('error: --host <id> is required for hacm import\n');
    return 1;
  }

  const filePath = options.file;
  if (!filePath) {
    process.stderr.write(
      'error: --file <path> is required (provide a Proxmox .conf file or - for stdin)\n',
    );
    return 1;
  }

  let rawConf: string;
  try {
    if (filePath === '-') {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      rawConf = Buffer.concat(chunks).toString('utf8');
    } else {
      rawConf = await readFile(resolve(filePath), 'utf8');
    }
  } catch (err) {
    process.stderr.write(
      `error: Failed to read config file "${filePath}": ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  const vmid = options.vmid ?? 100;
  const guestType = options.type ?? detectProxmoxConfigType(rawConf);
  const liveGuest = parseProxmoxConfig(rawConf, guestType, vmid);

  // Try to load default-deployment.yaml if present
  let defaults:
    ReturnType<typeof deploymentDefaultsFileSchema.parse> | undefined =
    undefined;
  try {
    const defaultsPath = join(
      dataDir,
      'hosts',
      hostId,
      'default-deployment.yaml',
    );
    const defaultsContent = await readFile(defaultsPath, 'utf8');
    const doc = loadYamlDocument(defaultsContent);
    defaults = deploymentDefaultsFileSchema.parse(doc.toJSON());
  } catch {
    // Defaults file is optional
  }

  const plan = await planGuestImport({
    dataDir,
    hostId,
    guest: liveGuest,
    defaults,
  });

  if (options.dryRun) {
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({ plan, status: plan.status }, null, 2)}\n`,
      );
    } else {
      process.stdout.write(
        `Import plan for ${plan.type.toUpperCase()} ${plan.vmid} (${plan.name}):\n` +
          `  Target: ${plan.relativeFile}\n` +
          `  Status: ${plan.status}\n` +
          (plan.omittedDefaults.length > 0
            ? `  Omitted (matches default): ${plan.omittedDefaults.join(', ')}\n`
            : '') +
          `\n--- YAML Content ---\n${plan.yamlContent}\n`,
      );
    }
    return 0;
  }

  const result = await applyGuestImport({
    plan,
    overwrite: options.overwrite ?? false,
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...result, plan }, null, 2)}\n`);
    return result.success ? 0 : 1;
  }

  if (!result.success) {
    process.stderr.write(
      `error: Failed to import guest: ${result.reason === 'already_exists' ? `File already exists at ${result.relativeFile} (use --overwrite to force)` : result.reason}\n`,
    );
    return 1;
  }

  process.stdout.write(
    `✓ Imported ${plan.type.toUpperCase()} ${plan.vmid} (${plan.name}) into ${result.relativeFile}\n`,
  );
  return 0;
}

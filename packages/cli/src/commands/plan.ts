import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  createMutationPlan,
  detectProxmoxConfigType,
  loadYamlDocument,
  hashContent,
  parseProxmoxConfig,
  planGuestImport,
  type MutationPlan,
} from '@hacm/core';
import { loadDeploymentDefaults, readLocalTarget } from './plan-file.js';

export interface LocalGuestImportPlanDocument {
  readonly schemaVersion: 1;
  readonly plan: MutationPlan;
  readonly payload: {
    readonly hostId: string;
    readonly dataDir: string;
    readonly vmid: number;
    readonly type: 'lxc' | 'vm';
    readonly sourceFile: string;
    readonly overwrite: boolean;
    readonly generatedAt: string;
  };
}

export interface CliPlanOptions {
  readonly dataDir?: string | undefined;
  readonly host?: string | undefined;
  readonly file?: string | undefined;
  readonly vmid?: number | undefined;
  readonly type?: 'lxc' | 'vm' | undefined;
  readonly overwrite?: boolean | undefined;
  readonly out?: string | undefined;
  readonly json?: boolean | undefined;
}

export async function runPlan(options: CliPlanOptions = {}): Promise<number> {
  const dataDir = resolve(
    options.dataDir ?? process.env.HACM_DATA_DIR ?? process.cwd(),
  );
  if (!options.host) {
    process.stderr.write('error: --host <id> is required for hacm plan\n');
    return 1;
  }
  if (!options.file || options.file === '-') {
    process.stderr.write(
      'error: --file <path> is required for hacm plan (stdin cannot be rechecked during apply)\n',
    );
    return 1;
  }

  const sourceFile = resolve(options.file);
  let rawConfig: string;
  try {
    rawConfig = await readFile(sourceFile, 'utf8');
  } catch (error) {
    process.stderr.write(
      `error: Failed to read config file "${options.file}": ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }

  try {
    const vmid = options.vmid ?? 100;
    const type = options.type ?? detectProxmoxConfigType(rawConfig);
    const live = parseProxmoxConfig(rawConfig, type, vmid);
    const defaults = await loadDeploymentDefaults(dataDir, options.host);
    const generatedAt = new Date();
    const importPlan = await planGuestImport({
      dataDir,
      hostId: options.host,
      guest: live,
      defaults,
      generatedAt,
    });
    const target = await readLocalTarget(importPlan.fullPath);
    const overwrite = options.overwrite ?? false;
    if (target.exists && !overwrite) {
      process.stderr.write(
        `error: ${importPlan.relativeFile} already exists; use --overwrite to create a destructive replacement plan\n`,
      );
      return 1;
    }
    const destructive = target.exists;
    const currentState = {
      live,
      defaults: defaults ?? null,
      sourceHash: await hashContent(rawConfig),
      target: { exists: target.exists, hash: target.hash },
    };
    const warnings = [
      ...(importPlan.omittedDefaults.length > 0
        ? [
            `Omitted values matching host defaults: ${importPlan.omittedDefaults.join(', ')}`,
          ]
        : []),
      ...(destructive
        ? ['The existing deployment YAML will be atomically replaced.']
        : []),
    ];
    const plan = createMutationPlan({
      id: randomUUID(),
      operation: 'guest.import',
      target: {
        hostId: options.host,
        vmid,
        resourceType: 'guest',
      },
      summary: `${destructive ? 'Replace' : 'Create'} YAML for ${type.toUpperCase()} ${vmid} (${live.name})`,
      currentState,
      changes: [
        {
          id: 'deployment-file',
          action: destructive ? 'update' : 'create',
          path: importPlan.relativeFile,
          summary: `${destructive ? 'Replace' : 'Create'} deployment.yaml`,
          before: target.exists ? target.value : null,
          after: loadYamlDocument(importPlan.yamlContent).toJSON(),
          warnings,
          destructive,
        },
      ],
      warnings,
      ...(destructive
        ? { confirmationText: `OVERWRITE ${options.host}/${vmid}` }
        : {}),
      createdAt: generatedAt,
    });
    const document: LocalGuestImportPlanDocument = {
      schemaVersion: 1,
      plan,
      payload: {
        hostId: options.host,
        dataDir,
        vmid,
        type,
        sourceFile,
        overwrite,
        generatedAt: generatedAt.toISOString(),
      },
    };
    const serialized = `${JSON.stringify(document, null, 2)}\n`;
    if (options.out) {
      await writeFile(resolve(options.out), serialized, 'utf8');
    }
    if (options.json) {
      process.stdout.write(serialized);
    } else {
      process.stdout.write(
        `Plan ${plan.id}: ${plan.summary}\n` +
          `  Target: ${importPlan.relativeFile}\n` +
          `  Fingerprint: ${plan.stateFingerprint}\n` +
          `  Destructive: ${plan.destructive ? 'yes' : 'no'}\n` +
          (options.out ? `  Saved: ${resolve(options.out)}\n` : '') +
          `${warnings.map((warning) => `  Warning: ${warning}\n`).join('')}`,
      );
    }
    return 0;
  } catch (error) {
    process.stderr.write(
      `error: Failed to create plan: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

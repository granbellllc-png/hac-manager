import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  applyGuestImport,
  executeMutationPlan,
  hashContent,
  parseMutationPlan,
  parseProxmoxConfig,
  planGuestImport,
  type PlanChange,
} from '@hacm/core';
import type { LocalGuestImportPlanDocument } from './plan.js';
import { loadDeploymentDefaults, readLocalTarget } from './plan-file.js';

export interface CliApplyOptions {
  readonly dataDir?: string | undefined;
  readonly plan?: string | undefined;
  readonly dryRun?: boolean | undefined;
  readonly confirmation?: string | undefined;
  readonly json?: boolean | undefined;
}

function parseDocument(value: unknown): LocalGuestImportPlanDocument {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Plan document must be an object');
  }
  const record = value as Record<string, unknown>;
  if (record['schemaVersion'] !== 1) {
    throw new Error('Unsupported plan document version');
  }
  const plan = parseMutationPlan(record['plan']);
  const payload = record['payload'];
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('Plan document payload is missing');
  }
  const fields = payload as Record<string, unknown>;
  if (
    typeof fields['hostId'] !== 'string' ||
    typeof fields['dataDir'] !== 'string' ||
    typeof fields['vmid'] !== 'number' ||
    (fields['type'] !== 'lxc' && fields['type'] !== 'vm') ||
    typeof fields['sourceFile'] !== 'string' ||
    typeof fields['overwrite'] !== 'boolean' ||
    typeof fields['generatedAt'] !== 'string'
  ) {
    throw new Error('Plan document payload is invalid');
  }
  return {
    schemaVersion: 1,
    plan,
    payload: {
      hostId: fields['hostId'],
      dataDir: fields['dataDir'],
      vmid: fields['vmid'],
      type: fields['type'],
      sourceFile: fields['sourceFile'],
      overwrite: fields['overwrite'],
      generatedAt: fields['generatedAt'],
    },
  };
}

export async function runApply(options: CliApplyOptions = {}): Promise<number> {
  if (!options.plan) {
    process.stderr.write('error: --plan <path> is required for hacm apply\n');
    return 1;
  }
  const dataDir = resolve(
    options.dataDir ?? process.env.HACM_DATA_DIR ?? process.cwd(),
  );

  try {
    const document = parseDocument(
      JSON.parse(await readFile(resolve(options.plan), 'utf8')) as unknown,
    );
    const { plan, payload } = document;
    if (plan.operation !== 'guest.import') {
      throw new Error(`Unsupported plan operation '${plan.operation}'`);
    }
    if (resolve(payload.dataDir) !== dataDir) {
      throw new Error(
        `Plan belongs to data directory '${payload.dataDir}', not '${dataDir}'`,
      );
    }
    if (
      plan.target.hostId !== payload.hostId ||
      plan.target.vmid !== payload.vmid
    ) {
      throw new Error('Plan target does not match its payload');
    }
    if (plan.destructive && options.confirmation !== plan.confirmationText) {
      throw new Error(
        `Typed confirmation must exactly match '${plan.confirmationText ?? ''}'`,
      );
    }

    const rawConfig = await readFile(payload.sourceFile, 'utf8');
    const live = parseProxmoxConfig(rawConfig, payload.type, payload.vmid);
    const defaults = await loadDeploymentDefaults(dataDir, payload.hostId);
    const importPlan = await planGuestImport({
      dataDir,
      hostId: payload.hostId,
      guest: live,
      defaults,
      generatedAt: new Date(payload.generatedAt),
    });
    const target = await readLocalTarget(importPlan.fullPath);
    const currentState = {
      live,
      defaults: defaults ?? null,
      sourceHash: await hashContent(rawConfig),
      target: { exists: target.exists, hash: target.hash },
    };
    const result = await executeMutationPlan({
      plan,
      dryRun: options.dryRun ?? false,
      signal: new AbortController().signal,
      getCurrentState: async () => currentState,
      executeChange: async (change: PlanChange, context) => {
        if (change.id !== 'deployment-file') {
          throw new Error(`Unsupported plan change '${change.id}'`);
        }
        if (change.path !== importPlan.relativeFile) {
          throw new Error(
            'Plan target path does not match the regenerated import',
          );
        }
        if (context.dryRun) {
          return {
            status: 'skipped',
            detail: { relativeFile: importPlan.relativeFile },
          };
        }
        const applied = await applyGuestImport({
          plan: importPlan,
          overwrite: payload.overwrite,
          expectedHash: target.hash ?? '',
        });
        if (!applied.success) {
          throw new Error(
            `Guest import failed: ${applied.reason ?? 'unknown error'}`,
          );
        }
        return {
          status: 'applied',
          detail: { relativeFile: applied.relativeFile },
        };
      },
    });

    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(
        `${result.dryRun ? 'Dry-run completed' : 'Applied'} plan ${result.planId}: ${importPlan.relativeFile}\n`,
      );
    }
    return 0;
  } catch (error) {
    process.stderr.write(
      `error: Failed to apply plan: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

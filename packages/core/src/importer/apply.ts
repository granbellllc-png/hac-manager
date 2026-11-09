import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FileSystem } from '../yaml/file.js';
import { defaultNodeFileSystem } from '../yaml/file.js';
import type { WriteGuard } from '../data-dir/write-guard.js';
import { WriteGuard as DefaultWriteGuard } from '../data-dir/write-guard.js';
import { hashContent } from '../data-dir/hash.js';
import type { ApplyImportResult, GuestImportPlan } from './types.js';

export interface ApplyGuestImportOptions {
  readonly plan: GuestImportPlan;
  readonly fs?: FileSystem | undefined;
  readonly writeGuard?: WriteGuard | undefined;
  readonly overwrite?: boolean | undefined;
  readonly expectedHash?: string | undefined;
}

export async function applyGuestImport(
  options: ApplyGuestImportOptions,
): Promise<ApplyImportResult> {
  const { plan, overwrite } = options;
  const fs = options.fs ?? defaultNodeFileSystem;

  // Refuse overwrite if file already exists and overwrite flag is not set
  if (plan.status === 'already_exists' && !overwrite) {
    return {
      success: false,
      relativeFile: plan.relativeFile,
      fullPath: plan.fullPath,
      reason: 'already_exists',
    };
  }

  // Ensure parent directory exists
  await mkdir(dirname(plan.fullPath), { recursive: true });

  if (options.expectedHash !== undefined) {
    const guard = options.writeGuard ?? new DefaultWriteGuard();
    await guard.assertCanWrite(plan.fullPath, options.expectedHash, fs);
  }

  // Write deployment.yaml atomically so readers never observe a partial file.
  const temporaryPath = `${plan.fullPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
  try {
    await fs.writeFile(temporaryPath, plan.yamlContent, { encoding: 'utf8' });
    await fs.rename(temporaryPath, plan.fullPath);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }

  // Update write guard if provided
  if (options.writeGuard) {
    const hash = await hashContent(plan.yamlContent);
    options.writeGuard.registerHash(plan.fullPath, hash);
  }

  return {
    success: true,
    relativeFile: plan.relativeFile,
    fullPath: plan.fullPath,
  };
}

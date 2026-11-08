import { dirname } from 'node:path';
import { isTagValue } from '../schema/common.js';
import { resolveTag } from './resolver.js';
import type {
  ResolutionContext,
  ResolutionResult,
  ResolvedTagError,
  ResolvedTagLocked,
  ResolvedTagUnresolved,
  TagResolutionReport,
} from './types.js';

export async function resolveConfigTags<T = unknown>(
  input: unknown,
  context: ResolutionContext,
): Promise<ResolutionResult<T>> {
  let totalTags = 0;
  let resolvedCount = 0;
  const unresolved: ResolvedTagUnresolved[] = [];
  const locked: ResolvedTagLocked[] = [];
  const errors: ResolvedTagError[] = [];

  async function walk(
    val: unknown,
    currentCtx: ResolutionContext,
  ): Promise<unknown> {
    if (val === null || val === undefined) {
      return val;
    }

    if (isTagValue(val)) {
      totalTags++;
      const res = await resolveTag(val, currentCtx);

      switch (res.status) {
        case 'resolved': {
          resolvedCount++;
          // If the resolved value was from an !include, recursively resolve tags within it
          if (res.tag === 'include') {
            const nextIncludedPaths = new Set(currentCtx.includedPaths ?? []);
            const resolvedPath = (res as { resolvedPath?: string })
              .resolvedPath;
            if (resolvedPath) {
              nextIncludedPaths.add(resolvedPath);
            }
            const nextCtx: ResolutionContext = {
              ...currentCtx,
              currentFileDir: resolvedPath
                ? dirname(resolvedPath)
                : currentCtx.currentFileDir,
              includedPaths: nextIncludedPaths,
            };
            return walk(res.value, nextCtx);
          }
          return res.value;
        }

        case 'unresolved':
          unresolved.push(res);
          return val; // preserve TagValue in result

        case 'locked':
          locked.push(res);
          return val; // preserve TagValue in result

        case 'error':
          errors.push(res);
          return val; // preserve TagValue in result
      }
    }

    if (Array.isArray(val)) {
      const arrRes: unknown[] = [];
      for (const item of val) {
        arrRes.push(await walk(item, currentCtx));
      }
      return arrRes;
    }

    if (typeof val === 'object') {
      const objRes: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        objRes[k] = await walk(v, currentCtx);
      }
      return objRes;
    }

    return val;
  }

  const resolvedData = (await walk(input, context)) as T;

  const report: TagResolutionReport = {
    totalTags,
    resolvedCount,
    unresolved,
    locked,
    errors,
    isFullyResolved: totalTags === resolvedCount,
  };

  return {
    data: resolvedData,
    report,
  };
}

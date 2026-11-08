import { isScalar, type Document } from 'yaml';
import { hashContent } from '../data-dir/hash.js';
import { WriteConflictError, WriteGuard } from '../data-dir/write-guard.js';
import { mergeConfigs } from '../merge/merge.js';
import type { MergeSource } from '../merge/types.js';
import { isTagValue, type TagValue } from '../schema/common.js';
import {
  defaultNodeFileSystem,
  readYamlFile,
  type FileSystem,
} from '../yaml/file.js';
import { setScalar } from '../yaml/mutate.js';
import {
  formatYamlPath,
  normalizeYamlPath,
  type YamlPath,
} from '../yaml/path.js';
import type {
  ApplyPatchOptions,
  ApplyPatchResult,
  ApplyPatchSuccess,
  PatchTarget,
} from './types.js';

function isCstNodeTagged(node: unknown): { isTagged: boolean; tag?: string } {
  if (isScalar(node) && typeof node.tag === 'string' && node.tag.length > 0) {
    const cleanTag = node.tag.startsWith('!') ? node.tag.slice(1) : node.tag;
    return { isTagged: true, tag: cleanTag };
  }
  return { isTagged: false };
}

export async function applyPatch(
  target: PatchTarget,
  path: YamlPath,
  value: unknown,
  options: ApplyPatchOptions = {},
): Promise<ApplyPatchResult> {
  const fs: FileSystem = options.fs ?? defaultNodeFileSystem;
  const normPath = normalizeYamlPath(path);
  const pathString = formatYamlPath(normPath);

  if (normPath.length === 0) {
    return {
      success: false,
      reason: 'invalid_path',
      message: 'Cannot patch the document root',
    };
  }

  const guestFilePath = target.deploymentFile;
  const defaultFilePath =
    options.defaultDeploymentFile ??
    ('defaultDeploymentFile' in target
      ? target.defaultDeploymentFile
      : undefined) ??
    options.host?.defaultDeploymentFile;

  let guestFileResult;
  try {
    guestFileResult = await readYamlFile(guestFilePath, fs);
  } catch (err) {
    return {
      success: false,
      reason: 'target_not_found',
      message: `Failed to read guest deployment file "${guestFilePath}": ${(err as Error).message}`,
      targetFile: guestFilePath,
      layer: 'override',
    };
  }

  let defaultFileResult;
  if (defaultFilePath) {
    try {
      defaultFileResult = await readYamlFile(defaultFilePath, fs);
    } catch {
      defaultFileResult = undefined;
    }
  }

  const defaultSource: MergeSource | undefined = defaultFileResult
    ? {
        layer: 'default',
        file: defaultFilePath!,
        data: defaultFileResult.document.toJS(),
        document: defaultFileResult.document,
      }
    : undefined;

  const overrideSource: MergeSource = {
    layer: 'override',
    file: guestFilePath,
    data: guestFileResult.document.toJS(),
    document: guestFileResult.document,
  };

  const mergeResult = mergeConfigs(defaultSource, overrideSource, {
    identityMergedLists: ['network'],
  });

  const prov = mergeResult.provenance.get(normPath);

  // 1. Check tag protection
  if (prov && (prov.isTag || isTagValue(prov.value))) {
    const rawTag =
      prov.tag ??
      (isTagValue(prov.value) ? (prov.value as TagValue).tag : undefined);
    const rawVal =
      typeof prov.value === 'object' &&
      prov.value !== null &&
      'value' in prov.value
        ? String((prov.value as { value: unknown }).value)
        : String(prov.value);

    return {
      success: false,
      reason: 'tag_protected',
      tag: rawTag,
      rawTagValue: rawVal,
      message: `Cannot write back to tag-valued node '!${rawTag}' at '${pathString}' because it is computed or external`,
      targetFile: prov.file,
      layer: prov.layer,
    };
  }

  // Also verify against the CST node directly in guest and default documents
  const guestCstNode = guestFileResult.document.getIn(
    prov?.layer === 'override' && prov.sourcePath ? prov.sourcePath : normPath,
    true,
  );
  const guestTagCheck = isCstNodeTagged(guestCstNode);
  if (guestTagCheck.isTagged) {
    return {
      success: false,
      reason: 'tag_protected',
      tag: guestTagCheck.tag,
      rawTagValue: String((guestCstNode as { value?: unknown })?.value ?? ''),
      message: `Cannot write back to tag-valued node '!${guestTagCheck.tag}' at '${pathString}' in guest deployment`,
      targetFile: guestFilePath,
      layer: 'override',
    };
  }

  if (defaultFileResult && prov?.layer === 'default') {
    const defaultCstNode = defaultFileResult.document.getIn(
      prov.sourcePath ? prov.sourcePath : normPath,
      true,
    );
    const defaultTagCheck = isCstNodeTagged(defaultCstNode);
    if (defaultTagCheck.isTagged) {
      return {
        success: false,
        reason: 'tag_protected',
        tag: defaultTagCheck.tag,
        rawTagValue: String(
          (defaultCstNode as { value?: unknown })?.value ?? '',
        ),
        message: `Cannot write back to tag-valued node '!${defaultTagCheck.tag}' at '${pathString}' in default deployment`,
        targetFile: defaultFilePath,
        layer: 'default',
      };
    }
  }

  // 2. Select target file and layer
  const forceOverride = options.forceOverride ?? false;
  let targetFilePath: string;
  let targetLayer: 'override' | 'default';
  let targetDoc: Document;
  let targetPathInDoc: readonly (string | number)[];
  let targetRawContent: string;
  let overriddenInGuest = false;

  if (forceOverride) {
    targetFilePath = guestFilePath;
    targetLayer = 'override';
    targetDoc = guestFileResult.document;
    targetPathInDoc = normPath;
    targetRawContent = guestFileResult.raw;
    overriddenInGuest = prov?.layer === 'default';
  } else if (
    prov?.layer === 'default' &&
    defaultFilePath &&
    defaultFileResult
  ) {
    targetFilePath = defaultFilePath;
    targetLayer = 'default';
    targetDoc = defaultFileResult.document;
    targetPathInDoc = prov.sourcePath ?? normPath;
    targetRawContent = defaultFileResult.raw;
  } else {
    targetFilePath = guestFilePath;
    targetLayer = 'override';
    targetDoc = guestFileResult.document;
    targetPathInDoc = prov?.sourcePath ?? normPath;
    targetRawContent = guestFileResult.raw;
  }

  const previousValue = prov?.value ?? targetDoc.getIn(targetPathInDoc, true);

  // 3. Apply modification to CST
  setScalar(targetDoc, targetPathInDoc, value);

  // 4. Write back through WriteGuard
  let newHash: string | undefined;

  if (!options.dryRun) {
    const writeGuard = options.writeGuard ?? new WriteGuard();
    const currentHash = await hashContent(targetRawContent);
    const expectedHash =
      options.expectedHash ?? writeGuard.getHash(targetFilePath) ?? currentHash;

    try {
      const writeOutcome = await writeGuard.writeWithGuard(
        targetFilePath,
        targetDoc,
        expectedHash,
        fs,
      );
      newHash = writeOutcome.newHash;
    } catch (err) {
      if (err instanceof WriteConflictError) {
        if (options.throwOnConflict) {
          throw err;
        }
        return {
          success: false,
          reason: 'write_conflict',
          message: err.message,
          targetFile: targetFilePath,
          layer: targetLayer,
        };
      }
      throw err;
    }
  }

  const successResult: ApplyPatchSuccess = {
    success: true,
    targetFile: targetFilePath,
    layer: targetLayer,
    path: normPath,
    pathString,
    previousValue,
    newValue: value,
    newHash,
    overriddenInGuest,
  };

  return successResult;
}

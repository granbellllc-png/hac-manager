import type { Document } from 'yaml';
import { isTagValue, type TagValue } from '../schema/common.js';
import { formatYamlPath } from '../yaml/path.js';
import { DefaultProvenanceMap } from './provenance-map.js';
import type { MergeOptions, MergeResult, MergeSource } from './types.js';

interface ListModifier {
  readonly $append?: unknown[];
  readonly $prepend?: unknown[];
  readonly $replace?: unknown[];
}

function isListModifier(val: unknown): val is ListModifier {
  if (
    typeof val !== 'object' ||
    val === null ||
    Array.isArray(val) ||
    isTagValue(val)
  ) {
    return false;
  }
  const keys = Object.keys(val);
  return (
    keys.length === 1 &&
    (keys[0] === '$append' || keys[0] === '$prepend' || keys[0] === '$replace')
  );
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return (
    typeof val === 'object' &&
    val !== null &&
    !Array.isArray(val) &&
    !isTagValue(val) &&
    !isListModifier(val)
  );
}

function resolveCstNode(
  doc: Document | undefined,
  path: readonly (string | number)[],
): unknown {
  if (!doc) return undefined;
  try {
    return doc.getIn(path as (string | number)[], true) ?? undefined;
  } catch {
    return undefined;
  }
}

function getItemKey(item: unknown): string | undefined {
  if (!isPlainObject(item)) return undefined;
  if (item.index !== undefined && item.index !== null) {
    return `idx:${item.index}`;
  }
  if (item.name !== undefined && item.name !== null) {
    return `name:${item.name}`;
  }
  return undefined;
}

export function mergeConfigs<T = unknown>(
  defaultSource?: MergeSource,
  overrideSource?: MergeSource,
  options: MergeOptions = {},
): MergeResult<T> {
  const provenance = new DefaultProvenanceMap();
  const identityLists = new Set<string>(
    (options.identityMergedLists ?? ['network']).map((p) =>
      typeof p === 'string' ? p : p.join('.'),
    ),
  );

  function isIdentityList(path: readonly (string | number)[]): boolean {
    const key = path.join('.');
    const lastSeg = path.length > 0 ? String(path[path.length - 1]) : '';
    return identityLists.has(key) || identityLists.has(lastSeg);
  }

  function recordProvenance(
    mergedPath: readonly (string | number)[],
    source: MergeSource,
    sourcePath: readonly (string | number)[],
    val: unknown,
  ): void {
    const isTag = isTagValue(val);
    const tag = isTag ? (val as TagValue).tag : undefined;
    const node = resolveCstNode(source.document, sourcePath);

    provenance.set({
      path: mergedPath,
      pathString: formatYamlPath(mergedPath),
      layer: source.layer,
      file: source.file,
      sourcePath,
      node,
      isTag,
      tag,
      value: val,
    });
  }

  function recordAllFromSource(
    val: unknown,
    source: MergeSource,
    currentPath: readonly (string | number)[],
    sourcePath: readonly (string | number)[],
  ): unknown {
    if (val === undefined) return undefined;

    recordProvenance(currentPath, source, sourcePath, val);

    if (Array.isArray(val)) {
      return val.map((item, idx) =>
        recordAllFromSource(
          item,
          source,
          [...currentPath, idx],
          [...sourcePath, idx],
        ),
      );
    }

    if (isListModifier(val)) {
      const modKey =
        val.$append !== undefined
          ? '$append'
          : val.$prepend !== undefined
            ? '$prepend'
            : '$replace';
      const list = val[modKey] ?? [];
      return recordAllFromSource(list, source, currentPath, [
        ...sourcePath,
        modKey,
      ]);
    }

    if (isPlainObject(val)) {
      const res: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val)) {
        if (v !== undefined) {
          res[k] = recordAllFromSource(
            v,
            source,
            [...currentPath, k],
            [...sourcePath, k],
          );
        }
      }
      return res;
    }

    return val;
  }

  function mergeValues(
    defaultVal: unknown,
    overrideVal: unknown,
    currentPath: readonly (string | number)[],
    defaultPath: readonly (string | number)[],
    overridePath: readonly (string | number)[],
  ): unknown {
    // 1. If override specifies explicit null -> delete the key from merged output
    if (overrideVal === null) {
      if (overrideSource) {
        provenance.addRemovedKey({
          path: currentPath,
          pathString: formatYamlPath(currentPath),
          layer: 'override',
          file: overrideSource.file,
        });
      }
      return undefined;
    }

    // 2. If override is undefined (not set in override), inherit from default
    if (overrideVal === undefined) {
      if (defaultSource && defaultVal !== undefined) {
        return recordAllFromSource(
          defaultVal,
          defaultSource,
          currentPath,
          defaultPath,
        );
      }
      return undefined;
    }

    // At this point, overrideVal is defined, so overrideSource is guaranteed to exist.
    const ovrSource = overrideSource!;

    // 3. If default is undefined (not set in default), take everything from override
    if (defaultVal === undefined) {
      if (isListModifier(overrideVal)) {
        const modKey =
          overrideVal.$append !== undefined
            ? '$append'
            : overrideVal.$prepend !== undefined
              ? '$prepend'
              : '$replace';
        const list = overrideVal[modKey] ?? [];
        return recordAllFromSource(list, ovrSource, currentPath, [
          ...overridePath,
          modKey,
        ]);
      }
      return recordAllFromSource(
        overrideVal,
        ovrSource,
        currentPath,
        overridePath,
      );
    }

    // 4. Handle List Modifiers ($append, $prepend, $replace) on lists
    if (isListModifier(overrideVal)) {
      if (overrideVal.$replace !== undefined) {
        return recordAllFromSource(
          overrideVal.$replace,
          ovrSource,
          currentPath,
          [...overridePath, '$replace'],
        );
      }

      if (overrideVal.$append !== undefined) {
        const appended = overrideVal.$append;
        const res: unknown[] = [];
        // Inherit default items
        if (Array.isArray(defaultVal)) {
          for (let i = 0; i < defaultVal.length; i++) {
            res.push(
              recordAllFromSource(
                defaultVal[i],
                defaultSource!,
                [...currentPath, i],
                [...defaultPath, i],
              ),
            );
          }
        }
        // Append override items
        for (let i = 0; i < appended.length; i++) {
          const newIdx = res.length;
          res.push(
            recordAllFromSource(
              appended[i],
              ovrSource,
              [...currentPath, newIdx],
              [...overridePath, '$append', i],
            ),
          );
        }
        recordProvenance(currentPath, ovrSource, overridePath, res);
        return res;
      }

      const prepended = overrideVal.$prepend ?? [];
      const res: unknown[] = [];
      // Prepend override items
      for (let i = 0; i < prepended.length; i++) {
        res.push(
          recordAllFromSource(
            prepended[i],
            ovrSource,
            [...currentPath, i],
            [...overridePath, '$prepend', i],
          ),
        );
      }
      // Followed by default items
      if (Array.isArray(defaultVal)) {
        for (let i = 0; i < defaultVal.length; i++) {
          const newIdx = res.length;
          res.push(
            recordAllFromSource(
              defaultVal[i],
              defaultSource!,
              [...currentPath, newIdx],
              [...defaultPath, i],
            ),
          );
        }
      }
      recordProvenance(currentPath, ovrSource, overridePath, res);
      return res;
    }

    // 5. Handle Array Merging
    if (Array.isArray(overrideVal)) {
      // Identity-merged list (e.g. network)
      if (isIdentityList(currentPath) && Array.isArray(defaultVal)) {
        // If override is an explicit empty array, replace completely
        if (overrideVal.length === 0) {
          return recordAllFromSource(
            overrideVal,
            ovrSource,
            currentPath,
            overridePath,
          );
        }

        const res: unknown[] = [];
        const matchedOverrideIndices = new Set<number>();

        // Build index of override items by identity key
        const overrideByKey = new Map<
          string,
          { item: unknown; index: number }
        >();
        for (let j = 0; j < overrideVal.length; j++) {
          const item = overrideVal[j];
          const key = getItemKey(item);
          if (key !== undefined) {
            overrideByKey.set(key, { item, index: j });
          }
        }

        // Process default items in order
        for (let i = 0; i < defaultVal.length; i++) {
          const defItem = defaultVal[i];
          const key = getItemKey(defItem);
          const overrideMatch =
            key !== undefined ? overrideByKey.get(key) : undefined;

          if (overrideMatch) {
            matchedOverrideIndices.add(overrideMatch.index);
            const ovrItem = overrideMatch.item;

            // Check if override requested removal of this interface
            if (
              isPlainObject(ovrItem) &&
              (ovrItem._remove === true || ovrItem._delete === true)
            ) {
              provenance.addRemovedKey({
                path: [...currentPath, res.length],
                pathString: formatYamlPath([...currentPath, res.length]),
                layer: 'override',
                file: ovrSource.file,
              });
              continue;
            }

            const targetIdx = res.length;
            const mergedItem = mergeValues(
              defItem,
              ovrItem,
              [...currentPath, targetIdx],
              [...defaultPath, i],
              [...overridePath, overrideMatch.index],
            );
            if (mergedItem !== undefined) {
              res.push(mergedItem);
            }
          } else {
            // Keep default item as-is
            const targetIdx = res.length;
            res.push(
              recordAllFromSource(
                defItem,
                defaultSource!,
                [...currentPath, targetIdx],
                [...defaultPath, i],
              ),
            );
          }
        }

        // Append unmatched override items
        for (let j = 0; j < overrideVal.length; j++) {
          if (!matchedOverrideIndices.has(j)) {
            const ovrItem = overrideVal[j];
            if (
              isPlainObject(ovrItem) &&
              (ovrItem._remove === true || ovrItem._delete === true)
            ) {
              continue;
            }
            const targetIdx = res.length;
            res.push(
              recordAllFromSource(
                ovrItem,
                ovrSource,
                [...currentPath, targetIdx],
                [...overridePath, j],
              ),
            );
          }
        }

        recordProvenance(currentPath, ovrSource, overridePath, res);
        return res;
      }

      // Default list semantics: REPLACE
      return recordAllFromSource(
        overrideVal,
        ovrSource,
        currentPath,
        overridePath,
      );
    }

    // 6. Handle Plain Object Merging
    if (isPlainObject(overrideVal) && isPlainObject(defaultVal)) {
      const res: Record<string, unknown> = {};
      const allKeys = new Set([
        ...Object.keys(defaultVal),
        ...Object.keys(overrideVal),
      ]);

      recordProvenance(currentPath, ovrSource, overridePath, res);

      for (const key of allKeys) {
        const defV = defaultVal[key];
        const ovrV = overrideVal[key];
        const mergedVal = mergeValues(
          defV,
          ovrV,
          [...currentPath, key],
          [...defaultPath, key],
          [...overridePath, key],
        );
        if (mergedVal !== undefined) {
          res[key] = mergedVal;
        }
      }
      return res;
    }

    // 7. Leaf / Scalar / TagValue: Override wins
    return recordAllFromSource(
      overrideVal,
      ovrSource,
      currentPath,
      overridePath,
    );
  }

  const defaultData = defaultSource?.data;
  const overrideData = overrideSource?.data;

  const merged = mergeValues(defaultData, overrideData, [], [], []) as T;

  return {
    merged,
    provenance,
  };
}

import {
  isMap,
  isSeq,
  isScalar,
  Scalar,
  type Document,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml';
import { isTagValue } from '../schema/common.js';
import { normalizeYamlPath, type YamlPath } from './path.js';
import { wrapTaggedValue } from './tags.js';

export function getYamlNode(document: Document, path: YamlPath): unknown {
  const normalized = normalizeYamlPath(path);
  return document.getIn(normalized, true);
}

export function setScalar(
  document: Document,
  path: YamlPath,
  value: unknown,
): void {
  const normalized = normalizeYamlPath(path);
  if (normalized.length === 0) {
    throw new Error('Cannot set scalar at document root');
  }

  const existing = document.getIn(normalized, true);
  if (isScalar(existing)) {
    if (isTagValue(value)) {
      existing.value = { tag: value.tag, value: value.value };
      existing.tag = `!${value.tag}`;
      if (
        value.value.includes(' ') ||
        value.value.includes('(') ||
        value.value.includes("'") ||
        value.value.includes('"')
      ) {
        existing.type = Scalar.QUOTE_DOUBLE;
      }
    } else {
      existing.value = value;
      delete existing.tag;
    }
    return;
  }

  document.setIn(normalized, wrapTaggedValue(value));
}

export function insertKey(
  document: Document,
  mapPath: YamlPath,
  key: string,
  value: unknown,
  options?: { readonly after?: string; readonly before?: string },
): void {
  const normalized = normalizeYamlPath(mapPath);
  const target =
    normalized.length === 0
      ? document.contents
      : document.getIn(normalized, true);

  if (!isMap(target)) {
    throw new Error(
      `Target at path "${normalized.join('.')}" is not a YAML map`,
    );
  }

  const map = target as YAMLMap;
  const existingIndex = map.items.findIndex(
    (item) => isScalar(item.key) && String(item.key.value) === key,
  );
  if (existingIndex !== -1) {
    map.items.splice(existingIndex, 1);
  }

  const pair = document.createPair(key, wrapTaggedValue(value));

  if (options?.after !== undefined) {
    const afterIndex = map.items.findIndex(
      (item) => isScalar(item.key) && String(item.key.value) === options.after,
    );
    if (afterIndex !== -1) {
      map.items.splice(afterIndex + 1, 0, pair);
      return;
    }
  }

  if (options?.before !== undefined) {
    const beforeIndex = map.items.findIndex(
      (item) => isScalar(item.key) && String(item.key.value) === options.before,
    );
    if (beforeIndex !== -1) {
      map.items.splice(beforeIndex, 0, pair);
      return;
    }
  }

  map.items.push(pair);
}

export function removeKey(document: Document, path: YamlPath): boolean {
  const normalized = normalizeYamlPath(path);
  if (normalized.length === 0) {
    return false;
  }

  const parentPath = normalized.slice(0, -1);
  const key = normalized[normalized.length - 1]!;
  const parent =
    parentPath.length === 0
      ? document.contents
      : document.getIn(parentPath, true);

  if (!isMap(parent)) {
    return false;
  }

  const map = parent as YAMLMap;
  const index = map.items.findIndex(
    (item) => isScalar(item.key) && String(item.key.value) === String(key),
  );
  if (index === -1) {
    return false;
  }

  map.items.splice(index, 1);
  return true;
}

export function appendToList(
  document: Document,
  listPath: YamlPath,
  value: unknown,
): void {
  const normalized = normalizeYamlPath(listPath);
  const target =
    normalized.length === 0
      ? document.contents
      : document.getIn(normalized, true);

  if (!isSeq(target)) {
    throw new Error(
      `Target at path "${normalized.join('.')}" is not a YAML list`,
    );
  }

  const seq = target as YAMLSeq;
  seq.items.push(document.createNode(wrapTaggedValue(value)));
}

export function removeFromList(
  document: Document,
  listPath: YamlPath,
  index: number,
): boolean {
  const normalized = normalizeYamlPath(listPath);
  const target =
    normalized.length === 0
      ? document.contents
      : document.getIn(normalized, true);

  if (!isSeq(target)) {
    return false;
  }

  const seq = target as YAMLSeq;
  if (index < 0 || index >= seq.items.length) {
    return false;
  }

  seq.items.splice(index, 1);
  return true;
}

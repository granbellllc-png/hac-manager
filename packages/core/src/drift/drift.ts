import { MANAGED_GUEST_TAG } from '../guest/identity.js';
import type { ProvenanceMap } from '../merge/types.js';
import { isSensitiveKey } from '../redaction/sanitize.js';
import { isTagValue, type TagName } from '../schema/common.js';
import type { GuestDeployment } from '../schema/deployment.js';
import { compareSecretValues, Secret } from '../tags/secret.js';
import { formatYamlPath } from '../yaml/path.js';
import {
  defaultDriftIgnoredPaths,
  type ComputeGuestDriftOptions,
  type DriftCategory,
  type DriftChange,
  type DriftChangeKind,
  type DriftProvenance,
  type GuestDriftResult,
} from './types.js';

type PathSegment = string | number;

interface CompareContext {
  readonly changes: DriftChange[];
  readonly computedFields: Set<string>;
  readonly provenance: ProvenanceMap | undefined;
  readonly ignoredPaths: readonly string[];
}

interface KeyedItem {
  readonly item: unknown;
  readonly index: number;
  readonly key: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Secret) &&
    !isTagValue(value)
  );
}

function isDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Secret || b instanceof Secret) {
    return compareSecretValues(a, b);
  }
  if (a === null || a === undefined || b === null || b === undefined) {
    return false;
  }
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return (
      a.length === b.length &&
      a.every((item, index) => isDeepEqual(item, b[index]))
    );
  }
  const recordA = a as Record<string, unknown>;
  const recordB = b as Record<string, unknown>;
  const keysA = Object.keys(recordA);
  const keysB = Object.keys(recordB);
  return (
    keysA.length === keysB.length &&
    keysA.every((key) => isDeepEqual(recordA[key], recordB[key]))
  );
}

function secretHash(value: unknown): string {
  if (value instanceof Secret) return value.hash;
  if (typeof value === 'string') return new Secret(value).hash;
  return new Secret(JSON.stringify(value)).hash;
}

function sanitizeValue(value: unknown, sensitive = false): unknown {
  if (sensitive) return '***';
  if (value instanceof Secret) return '***';
  if (isTagValue(value)) {
    return { tag: value.tag, value: value.value };
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item));
  }
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      result[key] = sanitizeValue(child, isSensitiveKey(key));
    }
    return result;
  }
  return value;
}

function isIgnored(path: string, ignoredPaths: readonly string[]): boolean {
  return ignoredPaths.some(
    (ignored) =>
      ignored.length > 0 &&
      (path === ignored ||
        path.startsWith(`${ignored}.`) ||
        path.startsWith(`${ignored}[`)),
  );
}

function provenanceFor(
  provenance: ProvenanceMap | undefined,
  path: readonly PathSegment[],
): DriftProvenance | undefined {
  if (!provenance) return undefined;
  const entry = provenance.get(path);
  if (!entry) return undefined;
  return {
    layer: entry.layer,
    file: entry.file,
    path: entry.pathString,
    sourcePath: formatYamlPath(entry.sourcePath),
  };
}

function tagOf(
  provenance: ProvenanceMap | undefined,
  path: readonly PathSegment[],
): TagName | undefined {
  return provenance?.get(path)?.tag;
}

function isComputed(
  provenance: ProvenanceMap | undefined,
  path: readonly PathSegment[],
): boolean {
  return provenance?.get(path)?.isTag === true;
}

function hasTaggedDescendant(
  provenance: ProvenanceMap | undefined,
  path: readonly PathSegment[],
  tag?: TagName,
): boolean {
  if (!provenance) return false;
  for (const entry of provenance.entries()) {
    if (!entry.isTag) continue;
    if (tag && entry.tag !== tag) continue;
    if (entry.path.length < path.length) continue;
    if (path.every((segment, index) => entry.path[index] === segment)) {
      return true;
    }
  }
  return false;
}

function containsSecret(value: unknown): boolean {
  if (value instanceof Secret) return true;
  if (isTagValue(value)) return value.tag === 'secret';
  if (Array.isArray(value)) return value.some(containsSecret);
  if (isRecord(value)) {
    return Object.entries(value).some(
      ([key, child]) => isSensitiveKey(key) || containsSecret(child),
    );
  }
  return false;
}

function categoryForSensitive(path: readonly PathSegment[]): boolean {
  const last = path[path.length - 1];
  return typeof last === 'string' && isSensitiveKey(last);
}

function valueKind(desired: unknown, actual: unknown): DriftChangeKind {
  if (desired === undefined) return 'missing_in_yaml';
  if (actual === undefined) return 'missing_in_live';
  return 'changed';
}

function pushChange(
  context: CompareContext,
  desired: unknown,
  actual: unknown,
  resultPath: readonly PathSegment[],
  desiredPath: readonly PathSegment[],
  category: DriftCategory,
): void {
  const path = formatYamlPath(resultPath);
  if (isIgnored(path, context.ignoredPaths)) return;

  const computed =
    isComputed(context.provenance, desiredPath) ||
    hasTaggedDescendant(context.provenance, desiredPath);
  if (computed) context.computedFields.add(path);
  const tag = tagOf(context.provenance, desiredPath);
  const secret =
    categoryForSensitive(resultPath) ||
    desired instanceof Secret ||
    actual instanceof Secret ||
    tag === 'secret' ||
    containsSecret(desired) ||
    containsSecret(actual) ||
    hasTaggedDescendant(context.provenance, desiredPath, 'secret');

  const kind = valueKind(desired, actual);
  const warnings: string[] = [];
  if (
    category === 'disk' &&
    path.endsWith('.size_gb') &&
    typeof desired === 'number' &&
    typeof actual === 'number' &&
    desired < actual
  ) {
    warnings.push(
      'Disks only grow. Enforcing the smaller YAML size is blocked; pull the live size or resize manually.',
    );
  }

  context.changes.push({
    path,
    category,
    kind,
    desired: desired === undefined ? null : sanitizeValue(desired, secret),
    actual: actual === undefined ? null : sanitizeValue(actual, secret),
    pullable: !computed && !secret,
    computed,
    secret,
    ...(tag ? { tag } : {}),
    ...(provenanceFor(context.provenance, desiredPath)
      ? { provenance: provenanceFor(context.provenance, desiredPath) }
      : {}),
    ...(secret && desired !== undefined
      ? { desiredHash: secretHash(desired) }
      : {}),
    ...(secret && actual !== undefined
      ? { actualHash: secretHash(actual) }
      : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  });
}

function compareValue(
  desired: unknown,
  actual: unknown,
  resultPath: readonly PathSegment[],
  desiredPath: readonly PathSegment[],
  category: DriftCategory,
  context: CompareContext,
): void {
  const path = formatYamlPath(resultPath);
  if (isIgnored(path, context.ignoredPaths)) return;

  if (isTagValue(desired)) {
    context.computedFields.add(path);
    return;
  }
  if (isTagValue(actual)) {
    context.computedFields.add(path);
    return;
  }

  if (desired === undefined || actual === undefined) {
    if (desired === undefined && actual === undefined) return;
    pushChange(context, desired, actual, resultPath, desiredPath, category);
    return;
  }

  if (Array.isArray(desired) || Array.isArray(actual)) {
    if (isDeepEqual(desired, actual)) return;
    pushChange(context, desired, actual, resultPath, desiredPath, category);
    return;
  }

  if (isRecord(desired) && isRecord(actual)) {
    const keys = new Set([...Object.keys(desired), ...Object.keys(actual)]);
    for (const key of keys) {
      compareValue(
        desired[key],
        actual[key],
        [...resultPath, key],
        [...desiredPath, key],
        category,
        context,
      );
    }
    return;
  }

  if (isDeepEqual(desired, actual)) return;
  pushChange(context, desired, actual, resultPath, desiredPath, category);
}

function compareKeyedArray(
  desiredItems: readonly unknown[],
  actualItems: readonly unknown[],
  identityKey: 'index' | 'name',
  allowedKeys: readonly string[] | undefined,
  resultBase: readonly PathSegment[],
  desiredBase: readonly PathSegment[],
  category: DriftCategory,
  context: CompareContext,
): void {
  const toMap = (items: readonly unknown[]): Map<string, KeyedItem> => {
    const map = new Map<string, KeyedItem>();
    items.forEach((item, index) => {
      if (!isRecord(item)) return;
      const keyValue = item[identityKey];
      if (keyValue === undefined || keyValue === null) return;
      map.set(String(keyValue), { item, index, key: String(keyValue) });
    });
    return map;
  };

  const desiredMap = toMap(desiredItems);
  const actualMap = toMap(actualItems);
  const keys = [...new Set([...desiredMap.keys(), ...actualMap.keys()])].sort(
    (a, b) => a.localeCompare(b, undefined, { numeric: true }),
  );

  for (const key of keys) {
    const desired = desiredMap.get(key);
    const actual = actualMap.get(key);
    const displayIndex =
      identityKey === 'index'
        ? Number(key)
        : (desired?.index ?? actual?.index ?? 0);

    if (!desired) {
      pushChange(
        context,
        undefined,
        actual?.item,
        [...resultBase, displayIndex],
        [],
        category,
      );
      continue;
    }

    if (!actual) {
      pushChange(
        context,
        desired.item,
        undefined,
        [...resultBase, displayIndex],
        [...desiredBase, desired.index],
        category,
      );
      continue;
    }

    const desiredRecord = desired.item as Record<string, unknown>;
    const actualRecord = actual.item as Record<string, unknown>;
    const keysToCompare = allowedKeys ?? [
      ...new Set([...Object.keys(desiredRecord), ...Object.keys(actualRecord)]),
    ];

    for (const field of keysToCompare) {
      if (desiredRecord[field] === undefined) continue;
      compareValue(
        desiredRecord[field],
        actualRecord[field],
        [...resultBase, displayIndex, field],
        [...desiredBase, desired.index, field],
        category,
        context,
      );
    }
  }
}

function normalizedTags(tags: readonly string[] | undefined): string[] {
  return [
    ...new Set((tags ?? []).filter((tag) => tag !== MANAGED_GUEST_TAG)),
  ].sort((a, b) => a.localeCompare(b));
}

function withDefaults(
  value: unknown,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  return { ...defaults, ...(isRecord(value) ? value : {}) };
}

function compareGuestFields(
  desired: GuestDeployment,
  live: GuestDeployment,
  context: CompareContext,
): void {
  compareValue(
    desired.name,
    live.name,
    ['name'],
    ['name'],
    'identity',
    context,
  );
  compareValue(desired.cpu, live.cpu, ['cpu'], ['cpu'], 'config', context);
  compareValue(desired.ram, live.ram, ['ram'], ['ram'], 'config', context);

  compareKeyedArray(
    desired.disks,
    live.disks,
    'name',
    ['name', 'storage', 'size_gb'],
    ['disks'],
    ['disks'],
    'disk',
    context,
  );

  compareKeyedArray(
    desired.mounts ?? [],
    live.mounts ?? [],
    'index',
    ['index', 'host_path', 'guest_path', 'backup', 'readonly'],
    ['mounts'],
    ['mounts'],
    'mount',
    context,
  );

  compareKeyedArray(
    desired.network,
    live.network,
    'index',
    [
      'index',
      'name',
      'bridge',
      'ip',
      'gateway',
      'mac',
      'vlan',
      'mtu',
      'firewall',
      'ipv6',
      'ip6',
      'gateway6',
    ],
    ['network'],
    ['network'],
    'network',
    context,
  );

  const desiredTags = normalizedTags(desired.tags);
  const liveTags = normalizedTags(live.tags);
  if (!isDeepEqual(desiredTags, liveTags)) {
    pushChange(context, desiredTags, liveTags, ['tags'], ['tags'], 'tags');
  }

  compareValue(
    desired.protection ?? false,
    live.protection ?? false,
    ['protection'],
    ['protection'],
    'protection',
    context,
  );

  if (desired.type === 'lxc' && live.type === 'lxc') {
    compareValue(
      withDefaults(desired.features, {
        nesting: false,
        keyctl: false,
        fuse: false,
        mount: [],
      }),
      withDefaults(live.features, {
        nesting: false,
        keyctl: false,
        fuse: false,
        mount: [],
      }),
      ['features'],
      ['features'],
      'feature',
      context,
    );
    compareValue(
      desired.unprivileged ?? false,
      live.unprivileged ?? false,
      ['unprivileged'],
      ['unprivileged'],
      'config',
      context,
    );
    compareValue(
      desired.swap,
      live.swap,
      ['swap'],
      ['swap'],
      'config',
      context,
    );
    compareValue(
      desired.ostype,
      live.ostype,
      ['ostype'],
      ['ostype'],
      'config',
      context,
    );
    compareValue(
      desired.onboot ?? false,
      live.onboot ?? false,
      ['onboot'],
      ['onboot'],
      'config',
      context,
    );
    compareValue(
      desired.startup,
      live.startup,
      ['startup'],
      ['startup'],
      'config',
      context,
    );
  }

  if (desired.type === 'vm' && live.type === 'vm') {
    compareValue(
      desired.bios ?? 'seabios',
      live.bios ?? 'seabios',
      ['bios'],
      ['bios'],
      'config',
      context,
    );
    compareValue(
      desired.machine,
      live.machine,
      ['machine'],
      ['machine'],
      'config',
      context,
    );
    compareValue(
      desired.efi_disk ?? false,
      live.efi_disk ?? false,
      ['efi_disk'],
      ['efi_disk'],
      'config',
      context,
    );
    compareValue(
      desired.tpm ?? false,
      live.tpm ?? false,
      ['tpm'],
      ['tpm'],
      'config',
      context,
    );
    compareValue(
      desired.guest_agent ?? false,
      live.guest_agent ?? false,
      ['guest_agent'],
      ['guest_agent'],
      'config',
      context,
    );
    compareValue(
      desired.cloud_init,
      live.cloud_init,
      ['cloud_init'],
      ['cloud_init'],
      'cloud_init',
      context,
    );
  }
}

/**
 * Compare evaluated YAML with the canonical live guest configuration.
 *
 * The engine is pure: it performs no I/O, never resolves tags and never
 * returns plaintext secrets. Values that came from a tag are reported as
 * computed and are not pullable.
 */
export function computeGuestDrift(
  options: ComputeGuestDriftOptions,
): GuestDriftResult {
  const context: CompareContext = {
    changes: [],
    computedFields: new Set<string>(),
    provenance: options.provenance,
    ignoredPaths: [
      ...defaultDriftIgnoredPaths,
      ...(options.ignoredPaths ?? []),
    ],
  };

  compareGuestFields(options.desired, options.live, context);

  const checkedAt =
    options.checkedAt instanceof Date
      ? options.checkedAt.toISOString()
      : (options.checkedAt ?? new Date().toISOString());

  return {
    hostId: options.hostId,
    vmid: options.vmid,
    type: options.type,
    status: context.changes.length === 0 ? 'in_sync' : 'drifted',
    changes: context.changes,
    computedFields: [...context.computedFields].sort(),
    ignoredPaths: [...context.ignoredPaths],
    checkedAt,
  };
}

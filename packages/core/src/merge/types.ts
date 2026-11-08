import type { Document } from 'yaml';
import type { TagName } from '../schema/common.js';
import type { YamlPath } from '../yaml/path.js';

export type Layer = 'default' | 'override';

export interface ProvenanceEntry {
  /** The normalized path in the merged document, e.g. ['network', 0, 'ip'] */
  readonly path: readonly (string | number)[];
  /** Formatted string representation, e.g. 'network[0].ip' */
  readonly pathString: string;
  /** Whether the value originated from the default or override layer */
  readonly layer: Layer;
  /** File path where this value was defined */
  readonly file: string;
  /** The path within the source document (may differ for re-indexed list items) */
  readonly sourcePath: readonly (string | number)[];
  /** The CST Node in the source YAML document if a Document was provided */
  readonly node?: unknown | undefined;
  /** Whether the value is a tagged scalar (!env, !secret, !expr, !cmd, !include) */
  readonly isTag: boolean;
  /** The tag name if isTag is true */
  readonly tag?: TagName | undefined;
  /** The raw / unevaluated value */
  readonly value: unknown;
}

export interface RemovedKeyEntry {
  readonly path: readonly (string | number)[];
  readonly pathString: string;
  readonly layer: 'override';
  readonly file: string;
}

export interface MergeSource {
  readonly file: string;
  readonly layer: Layer;
  readonly data: unknown;
  readonly document?: Document | undefined;
}

export interface MergeOptions {
  /**
   * Property names or paths that merge by item identity rather than replace.
   * Defaults to `['network']`.
   */
  readonly identityMergedLists?:
    readonly (string | readonly (string | number)[])[] | undefined;
}

export interface ProvenanceMap {
  get(path: YamlPath): ProvenanceEntry | undefined;
  has(path: YamlPath): boolean;
  entries(): readonly ProvenanceEntry[];
  byFile(file: string): readonly ProvenanceEntry[];
  byLayer(layer: Layer): readonly ProvenanceEntry[];
  readonly removedKeys: readonly RemovedKeyEntry[];
}

export interface MergeResult<T = unknown> {
  readonly merged: T;
  readonly provenance: ProvenanceMap;
}

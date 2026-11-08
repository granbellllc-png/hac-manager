import {
  formatYamlPath,
  normalizeYamlPath,
  type YamlPath,
} from '../yaml/path.js';
import type {
  Layer,
  ProvenanceEntry,
  ProvenanceMap,
  RemovedKeyEntry,
} from './types.js';

export class DefaultProvenanceMap implements ProvenanceMap {
  private readonly entriesByPath = new Map<string, ProvenanceEntry>();
  private readonly _removedKeys: RemovedKeyEntry[] = [];

  public set(entry: ProvenanceEntry): void {
    this.entriesByPath.set(entry.pathString, entry);
  }

  public get(path: YamlPath): ProvenanceEntry | undefined {
    const normalized = normalizeYamlPath(path);
    const key = formatYamlPath(normalized);
    return this.entriesByPath.get(key);
  }

  public has(path: YamlPath): boolean {
    const normalized = normalizeYamlPath(path);
    const key = formatYamlPath(normalized);
    return this.entriesByPath.has(key);
  }

  public entries(): readonly ProvenanceEntry[] {
    return Array.from(this.entriesByPath.values());
  }

  public byFile(file: string): readonly ProvenanceEntry[] {
    return this.entries().filter((e) => e.file === file);
  }

  public byLayer(layer: Layer): readonly ProvenanceEntry[] {
    return this.entries().filter((e) => e.layer === layer);
  }

  public addRemovedKey(entry: RemovedKeyEntry): void {
    this._removedKeys.push(entry);
  }

  public get removedKeys(): readonly RemovedKeyEntry[] {
    return [...this._removedKeys];
  }
}

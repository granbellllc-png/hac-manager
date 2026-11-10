/**
 * Ordered task loading and execution (D-51).
 *
 * Tasks are declarative shell snippets delivered on stdin. Core never builds
 * nested `bash -c` strings and never resolves secrets into logs: computed
 * fields are resolved through the tag resolver and output passes through a
 * redactor before it is returned or streamed.
 */

import type { TagValue } from '../schema/common.js';
import type { Task } from './types.js';

export interface TaskTargets {
  readonly groups?: readonly string[] | undefined;
  readonly tags?: readonly string[] | undefined;
}

/** Host identity supplied by the caller; groups/tags are optional metadata. */
export interface TaskHostIdentity {
  readonly id: string;
  readonly name?: string | undefined;
  readonly groups?: readonly string[] | undefined;
  readonly tags?: readonly string[] | undefined;
}

/**
 * Tier 1 selection: a file without targets applies everywhere. With targets,
 * a host matches when it belongs to one listed group or carries one listed tag.
 */
export function taskTargetsMatchHost(
  targets: TaskTargets | undefined,
  host: TaskHostIdentity,
): boolean {
  if (!targets) return true;
  const groups = targets.groups?.filter((group) => group.length > 0) ?? [];
  const tags = targets.tags?.filter((tag) => tag.length > 0) ?? [];
  if (groups.length === 0 && tags.length === 0) return true;
  const hostGroups = new Set(host.groups ?? []);
  const hostTags = new Set(host.tags ?? []);
  return (
    groups.some((group) => hostGroups.has(group)) ||
    tags.some((tag) => hostTags.has(tag))
  );
}

interface OrderKey {
  readonly numeric: boolean;
  readonly value: number;
  readonly name: string;
}

/** Order by the leading numeric filename prefix, then lexicographically. */
export function taskFileOrderKey(name: string): OrderKey {
  const match = /^(\d+)/.exec(name);
  return match?.[1] !== undefined
    ? { numeric: true, value: Number(match[1]), name }
    : { numeric: false, value: 0, name };
}

export function compareTaskFileNames(left: string, right: string): number {
  const a = taskFileOrderKey(left);
  const b = taskFileOrderKey(right);
  if (a.numeric && b.numeric && a.value !== b.value) return a.value - b.value;
  if (a.numeric !== b.numeric) return a.numeric ? -1 : 1;
  return a.name.localeCompare(b.name);
}

export function orderTaskFiles<T extends { readonly name: string }>(
  files: readonly T[],
): readonly T[] {
  return [...files].sort((a, b) => compareTaskFileNames(a.name, b.name));
}

export interface TaskWithSource {
  readonly file: string;
  readonly task: Task;
}

/** True when a task field is a computed tag rather than a literal. */
export function isTaskTag(value: unknown): value is TagValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    'tag' in value &&
    'value' in value
  );
}

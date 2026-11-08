import type { EvaluationContext } from '../expr/types.js';
import type { TagName } from '../schema/common.js';
import type { FileSystem } from '../yaml/file.js';

export type SecretProviderResult =
  | { readonly status: 'found'; readonly value: string }
  | { readonly status: 'not_found'; readonly reason?: string | undefined }
  | { readonly status: 'locked'; readonly reason: string }
  | { readonly status: 'error'; readonly error: string };

export interface SecretProvider {
  resolveSecret(
    key: string,
  ): Promise<SecretProviderResult> | SecretProviderResult;
}

export type CmdProviderResult =
  | { readonly status: 'success'; readonly output: string }
  | { readonly status: 'not_allowed'; readonly reason: string }
  | { readonly status: 'locked'; readonly reason: string }
  | { readonly status: 'error'; readonly error: string };

export interface CmdProvider {
  resolveCmd(command: string): Promise<CmdProviderResult> | CmdProviderResult;
}

export type ResolvedTagStatus = 'resolved' | 'unresolved' | 'locked' | 'error';

export interface ResolvedTagSuccess<T = unknown> {
  readonly status: 'resolved';
  readonly value: T;
  readonly tag: TagName;
  readonly raw: string;
}

export interface ResolvedTagUnresolved {
  readonly status: 'unresolved';
  readonly reason: string;
  readonly tag: TagName;
  readonly raw: string;
}

export interface ResolvedTagLocked {
  readonly status: 'locked';
  readonly reason: string;
  readonly tag: TagName;
  readonly raw: string;
}

export interface ResolvedTagError {
  readonly status: 'error';
  readonly error: string;
  readonly tag: TagName;
  readonly raw: string;
}

export type ResolvedTagResult<T = unknown> =
  | ResolvedTagSuccess<T>
  | ResolvedTagUnresolved
  | ResolvedTagLocked
  | ResolvedTagError;

export interface ResolutionContext {
  /** Root of user configuration repo; all !include must stay within this directory */
  readonly dataDir: string;
  /** Directory containing the file being resolved, for relative !include resolution */
  readonly currentFileDir?: string | undefined;
  /** Environment variables available for !env tags (defaults to process.env) */
  readonly env?: Record<string, string | undefined> | undefined;
  /** Provider for !secret tags */
  readonly secretProvider?: SecretProvider | undefined;
  /** Provider for !cmd tags */
  readonly cmdProvider?: CmdProvider | undefined;
  /** Context variables for !expr tags (host, guest, vmid, net) */
  readonly evaluationContext?: EvaluationContext | undefined;
  /** Injected file system for !include */
  readonly fs?: FileSystem | undefined;
  /** Tracked include paths to prevent cyclic includes */
  readonly includedPaths?: ReadonlySet<string> | undefined;
}

export interface TagResolutionReport {
  readonly totalTags: number;
  readonly resolvedCount: number;
  readonly unresolved: readonly ResolvedTagUnresolved[];
  readonly locked: readonly ResolvedTagLocked[];
  readonly errors: readonly ResolvedTagError[];
  readonly isFullyResolved: boolean;
}

export interface ResolutionResult<T = unknown> {
  readonly data: T;
  readonly report: TagResolutionReport;
}

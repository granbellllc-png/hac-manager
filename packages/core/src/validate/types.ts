import type { SecretProvider, CmdProvider } from '../tags/types.js';
import type { FileSystem } from '../yaml/file.js';

export interface ValidateOptions {
  /** Path to the data directory to validate */
  readonly dataDir: string;
  /** Whether to resolve secrets and external commands (default: false) */
  readonly resolve?: boolean;
  /** Injected file system for testing */
  readonly fs?: FileSystem;
  /** Environment dictionary for !env resolution (defaults to process.env) */
  readonly env?: Record<string, string | undefined>;
  /** Provider for !secret tags */
  readonly secretProvider?: SecretProvider;
  /** Provider for !cmd tags */
  readonly cmdProvider?: CmdProvider;
}

export interface ValidationIssue {
  readonly file: string;
  readonly line?: number | undefined;
  readonly column?: number | undefined;
  readonly message: string;
  readonly code: string;
  readonly path?: string | undefined;
  readonly severity: 'error' | 'warning';
}

export interface ValidationStats {
  readonly hosts: number;
  readonly guests: number;
  readonly files: number;
}

export interface ValidateResult {
  readonly valid: boolean;
  readonly issues: readonly ValidationIssue[];
  readonly stats: ValidationStats;
}

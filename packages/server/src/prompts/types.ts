import type { PromptRow } from '../db/schema.js';

export type PromptKind = PromptRow['kind'];

export type PromptResolution =
  | { readonly kind: 'choice'; readonly choice: string }
  | { readonly kind: 'confirm'; readonly confirmed: boolean }
  | { readonly kind: 'typed_confirmation'; readonly text: string };

export interface PromptRequest {
  readonly id?: string | undefined;
  readonly jobId: string;
  readonly kind: PromptKind;
  readonly message: string;
  readonly payload?: unknown;
  readonly options?: readonly string[] | undefined;
  readonly expectedText?: string | undefined;
  readonly expiresAt?: Date | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface PublicPrompt {
  readonly id: string;
  readonly jobId: string;
  readonly hostId: string;
  readonly vmid?: number | undefined;
  readonly kind: PromptKind;
  readonly status: PromptRow['status'];
  readonly message: string;
  readonly payload: unknown;
  readonly options: readonly string[];
  readonly resolution?: PromptResolution | undefined;
  readonly resolvedBy?: string | undefined;
  readonly createdAt: string;
  readonly expiresAt?: string | undefined;
  readonly resolvedAt?: string | undefined;
}

export class PromptValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PromptValidationError';
  }
}

export class PromptExpiredError extends Error {
  public constructor(public readonly promptId: string) {
    super(`Prompt '${promptId}' has expired`);
    this.name = 'PromptExpiredError';
  }
}

export class PromptCancelledError extends Error {
  public constructor(public readonly promptId: string) {
    super(`Waiting for prompt '${promptId}' was cancelled`);
    this.name = 'PromptCancelledError';
  }
}

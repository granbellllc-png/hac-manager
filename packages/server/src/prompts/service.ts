import { createHash } from 'node:crypto';
import { sanitizeAuditPayload } from '@hacm/core';
import type { PromptRow } from '../db/schema.js';
import type { DatabaseRepositories } from '../db/repositories/types.js';
import type { JobEventBroker } from '../events/job-events.js';
import {
  PromptCancelledError,
  PromptExpiredError,
  PromptValidationError,
  type PromptRequest,
  type PromptResolution,
  type PublicPrompt,
} from './types.js';

interface Waiter {
  readonly resolve: (resolution: PromptResolution) => void;
  readonly reject: (error: unknown) => void;
  readonly cleanup: () => void;
}

function parseJson(value: string | null, fallback: unknown): unknown {
  if (value === null) return fallback;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return fallback;
  }
}

function parseResolution(row: PromptRow): PromptResolution | undefined {
  if (row.resolutionJson === null) return undefined;
  return parseJson(row.resolutionJson, undefined) as
    PromptResolution | undefined;
}

function validateRequest(request: PromptRequest): void {
  if (!request.message.trim()) {
    throw new PromptValidationError('Prompt message must not be empty');
  }
  if (
    request.kind === 'choice' &&
    (!request.options || request.options.length < 2)
  ) {
    throw new PromptValidationError(
      'Choice prompts require at least two options',
    );
  }
  if (request.kind === 'typed_confirmation' && !request.expectedText) {
    throw new PromptValidationError(
      'Typed confirmation prompts require expectedText',
    );
  }
}

function validateResolution(
  row: PromptRow,
  resolution: PromptResolution,
): void {
  if (row.kind !== resolution.kind) {
    throw new PromptValidationError(
      `Prompt kind '${row.kind}' cannot use '${resolution.kind}' resolution`,
    );
  }
  if (resolution.kind === 'choice') {
    const options = parseJson(row.optionsJson, []) as unknown;
    if (!Array.isArray(options) || !options.includes(resolution.choice)) {
      throw new PromptValidationError(
        `Choice '${resolution.choice}' is not an allowed option`,
      );
    }
  }
  if (
    resolution.kind === 'typed_confirmation' &&
    resolution.text !== row.expectedText
  ) {
    throw new PromptValidationError('Typed confirmation text does not match');
  }
}

export class PromptService {
  private readonly waiters = new Map<string, Set<Waiter>>();

  public constructor(
    private readonly repos: DatabaseRepositories,
    private readonly broker: JobEventBroker,
    private readonly resumeJob?:
      ((jobId: string) => Promise<boolean>) | undefined,
  ) {}

  public async request(request: PromptRequest): Promise<PromptResolution> {
    validateRequest(request);
    await this.expireDue();
    const id = request.id ?? this.defaultPromptId(request);
    let row = await this.repos.prompts.get(id);
    if (row && (row.jobId !== request.jobId || row.kind !== request.kind)) {
      throw new PromptValidationError(
        `Prompt '${id}' does not match the resumed request`,
      );
    }
    if (!row) {
      const safeMessage = sanitizeAuditPayload(request.message) as string;
      const safeOptions = sanitizeAuditPayload(
        request.options ?? [],
      ) as readonly string[];
      const safeExpectedText =
        request.expectedText === undefined
          ? undefined
          : (sanitizeAuditPayload(request.expectedText) as string);
      if (
        safeExpectedText !== undefined &&
        safeExpectedText !== request.expectedText
      ) {
        throw new PromptValidationError(
          'Typed confirmation text must not contain a resolved secret',
        );
      }
      row = await this.repos.prompts.create({
        id,
        jobId: request.jobId,
        kind: request.kind,
        status: 'pending',
        message: safeMessage,
        payloadJson:
          request.payload === undefined
            ? null
            : JSON.stringify(sanitizeAuditPayload(request.payload)),
        optionsJson:
          request.options === undefined
            ? null
            : JSON.stringify([...safeOptions]),
        expectedText: safeExpectedText ?? null,
        createdAt: new Date(),
        expiresAt: request.expiresAt ?? null,
      });
      const prompt = await this.toPublicPrompt(row);
      this.broker.publishPrompt({
        id: prompt.id,
        jobId: prompt.jobId,
        hostId: prompt.hostId,
        ...(prompt.vmid !== undefined ? { vmid: prompt.vmid } : {}),
        type: 'prompt.created',
        data: prompt,
        createdAt: prompt.createdAt,
      });
    }

    if (row.status === 'resolved') {
      const resolution = parseResolution(row);
      if (!resolution) {
        throw new PromptValidationError(
          `Prompt '${row.id}' has no readable resolution`,
        );
      }
      return resolution;
    }
    if (row.status === 'expired') throw new PromptExpiredError(row.id);
    return this.wait(row, request.signal);
  }

  public async resolve(
    promptId: string,
    user: { readonly id: string; readonly username: string },
    resolution: PromptResolution,
  ): Promise<PublicPrompt> {
    await this.expireDue();
    const row = await this.repos.prompts.get(promptId);
    if (!row) throw new PromptValidationError(`Prompt '${promptId}' not found`);
    if (row.status === 'expired') throw new PromptExpiredError(promptId);
    if (row.status === 'resolved') {
      throw new PromptValidationError(
        `Prompt '${promptId}' is already resolved`,
      );
    }
    validateResolution(row, resolution);
    const sanitized = sanitizeAuditPayload(resolution) as PromptResolution;
    const resolved = await this.repos.prompts.resolve(promptId, {
      resolutionJson: JSON.stringify(sanitized),
      resolvedBy: user.id,
    });
    if (!resolved) {
      throw new PromptValidationError(
        `Prompt '${promptId}' was resolved by another request`,
      );
    }
    const job = await this.repos.jobs.get(row.jobId);
    await this.repos.auditLogs.append({
      userId: user.id,
      username: user.username,
      hostId: job?.hostId ?? null,
      vmid: job?.vmid ?? null,
      action: 'prompt.resolve',
      reason: 'manual',
      jobId: row.jobId,
      diff: {
        promptId,
        kind: row.kind,
        resolution:
          resolution.kind === 'typed_confirmation'
            ? { kind: resolution.kind, matched: true }
            : sanitized,
      },
    });
    const prompt = await this.toPublicPrompt(resolved);
    this.broker.publishPrompt({
      id: prompt.id,
      jobId: prompt.jobId,
      hostId: prompt.hostId,
      ...(prompt.vmid !== undefined ? { vmid: prompt.vmid } : {}),
      type: 'prompt.resolved',
      data: prompt,
      createdAt: prompt.resolvedAt ?? new Date().toISOString(),
    });
    const promptWaiters = this.waiters.get(promptId);
    const hadWaiters = Boolean(promptWaiters?.size);
    for (const waiter of promptWaiters ?? []) {
      waiter.cleanup();
      waiter.resolve(sanitized);
    }
    this.waiters.delete(promptId);
    if (!hadWaiters) {
      await this.resumeJob?.(row.jobId);
    }
    return prompt;
  }

  public async get(promptId: string): Promise<PublicPrompt | null> {
    await this.expireDue();
    const row = await this.repos.prompts.get(promptId);
    return row ? this.toPublicPrompt(row) : null;
  }

  public async listPending(): Promise<readonly PublicPrompt[]> {
    await this.expireDue();
    const rows = await this.repos.prompts.list({ statuses: ['pending'] });
    return Promise.all(rows.map((row) => this.toPublicPrompt(row)));
  }

  public async expireDue(now = new Date()): Promise<number> {
    const pending = await this.repos.prompts.list({ statuses: ['pending'] });
    const due = pending.filter(
      (row) => row.expiresAt !== null && row.expiresAt <= now,
    );
    const count = await this.repos.prompts.expireDue(now);
    for (const row of due) {
      const error = new PromptExpiredError(row.id);
      const promptWaiters = this.waiters.get(row.id);
      const hadWaiters = Boolean(promptWaiters?.size);
      for (const waiter of promptWaiters ?? []) {
        waiter.cleanup();
        waiter.reject(error);
      }
      this.waiters.delete(row.id);
      const job = await this.repos.jobs.get(row.jobId);
      if (job) {
        this.broker.publishPrompt({
          id: row.id,
          jobId: row.jobId,
          hostId: job.hostId,
          ...(job.vmid !== null ? { vmid: job.vmid } : {}),
          type: 'prompt.expired',
          data: { id: row.id, status: 'expired' },
          createdAt: now.toISOString(),
        });
      }
      if (!hadWaiters) {
        await this.resumeJob?.(row.jobId);
      }
    }
    return count;
  }

  private async wait(
    row: PromptRow,
    signal?: AbortSignal,
  ): Promise<PromptResolution> {
    return new Promise<PromptResolution>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        cleanup();
        reject(new PromptCancelledError(row.id));
      };
      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        const promptWaiters = this.waiters.get(row.id);
        promptWaiters?.delete(waiter);
        if (promptWaiters?.size === 0) this.waiters.delete(row.id);
      };
      const waiter: Waiter = { resolve, reject, cleanup };
      let promptWaiters = this.waiters.get(row.id);
      if (!promptWaiters) {
        promptWaiters = new Set<Waiter>();
        this.waiters.set(row.id, promptWaiters);
      }
      promptWaiters.add(waiter);
      if (row.expiresAt !== null) {
        timeout = setTimeout(
          () => {
            void this.expireDue();
          },
          Math.max(0, row.expiresAt.getTime() - Date.now()),
        );
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  private async toPublicPrompt(row: PromptRow): Promise<PublicPrompt> {
    const job = await this.repos.jobs.get(row.jobId);
    if (!job) {
      throw new PromptValidationError(
        `Prompt '${row.id}' references missing job '${row.jobId}'`,
      );
    }
    const options = parseJson(row.optionsJson, []);
    return {
      id: row.id,
      jobId: row.jobId,
      hostId: job.hostId,
      ...(job.vmid !== null ? { vmid: job.vmid } : {}),
      kind: row.kind,
      status: row.status,
      message: row.message,
      payload: parseJson(row.payloadJson, {}),
      options: Array.isArray(options)
        ? options.filter((value): value is string => typeof value === 'string')
        : [],
      ...(parseResolution(row) ? { resolution: parseResolution(row)! } : {}),
      ...(row.resolvedBy !== null ? { resolvedBy: row.resolvedBy } : {}),
      createdAt: row.createdAt.toISOString(),
      ...(row.expiresAt !== null
        ? { expiresAt: row.expiresAt.toISOString() }
        : {}),
      ...(row.resolvedAt !== null
        ? { resolvedAt: row.resolvedAt.toISOString() }
        : {}),
    };
  }

  private defaultPromptId(request: PromptRequest): string {
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          request.kind,
          request.message,
          request.options ?? [],
          request.expectedText ?? null,
        ]),
      )
      .digest('hex')
      .slice(0, 20);
    return `${request.jobId}:${fingerprint}`;
  }
}

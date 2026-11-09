import {
  sanitizeAuditPayload,
  type StepJournal,
  type StepJournalEntry,
  type StepLogger,
} from '@hacm/core';
import type { DatabaseRepositories } from '../db/repositories/types.js';
import type { JobLogStream } from '../db/repositories/types.js';

function parseResultJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export class DatabaseStepJournal implements StepJournal {
  public constructor(private readonly repos: DatabaseRepositories) {}

  public async list(operationId: string): Promise<readonly StepJournalEntry[]> {
    const rows = await this.repos.jobSteps.list(operationId);
    return rows.map((row) => ({
      operationId: row.jobId,
      stepIndex: row.stepIndex,
      name: row.name,
      status: row.status,
      ...(row.resultJson !== null
        ? { result: parseResultJson(row.resultJson) }
        : {}),
      ...(row.rollbackHint !== null ? { rollbackHint: row.rollbackHint } : {}),
      ...(row.startedAt !== null ? { startedAt: row.startedAt } : {}),
      ...(row.finishedAt !== null ? { finishedAt: row.finishedAt } : {}),
    }));
  }

  public async save(entry: StepJournalEntry): Promise<void> {
    await this.repos.jobSteps.upsert({
      jobId: entry.operationId,
      stepIndex: entry.stepIndex,
      name: entry.name,
      status: entry.status,
      resultJson:
        entry.result === undefined
          ? null
          : JSON.stringify(sanitizeAuditPayload(entry.result)),
      rollbackHint: entry.rollbackHint ?? null,
      startedAt: entry.startedAt ?? null,
      finishedAt: entry.finishedAt ?? null,
    });
  }
}

export function createJobStepLogger(
  log: (stream: JobLogStream, text: string) => Promise<void>,
): StepLogger {
  return {
    info: (message) => log('system', message),
    warn: (message) => log('stderr', `Warning: ${message}`),
    error: (message) => log('stderr', message),
  };
}

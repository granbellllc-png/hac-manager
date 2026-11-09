import { EventEmitter } from 'node:events';
import { sanitizeAuditPayload } from '@hacm/core';
import type { JobLogLineRow, JobRow } from '../db/schema.js';
import type { DurableJobQueue } from '../jobs/queue.js';
import type { JobStatusEvent } from '../jobs/types.js';

export interface JobPromptEvent {
  readonly id: string;
  readonly jobId: string;
  readonly hostId: string;
  readonly vmid?: number | undefined;
  readonly userId?: string | undefined;
  readonly type: string;
  readonly data: unknown;
  readonly createdAt: string;
}

export class JobEventBroker extends EventEmitter {
  private readonly onQueueStatus = (event: JobStatusEvent) => {
    this.emit('job', event.job);
  };

  private readonly onQueueLog = (line: JobLogLineRow) => {
    this.emit('log', line);
  };

  public constructor(private readonly queue: DurableJobQueue) {
    super();
    queue.on('status', this.onQueueStatus);
    queue.on('log', this.onQueueLog);
  }

  public publishPrompt(event: JobPromptEvent): void {
    this.emit('prompt', {
      ...event,
      data: sanitizeAuditPayload(event.data),
    } satisfies JobPromptEvent);
  }

  public close(): void {
    this.queue.off('status', this.onQueueStatus);
    this.queue.off('log', this.onQueueLog);
    this.removeAllListeners();
  }
}

export interface SseEvent {
  readonly id?: string | number | undefined;
  readonly event?: string | undefined;
  readonly data?: unknown;
  readonly retry?: number | undefined;
  readonly comment?: string | undefined;
}

export function encodeSseEvent(event: SseEvent): string {
  const lines: string[] = [];
  if (event.comment !== undefined) lines.push(`: ${event.comment}`);
  if (event.retry !== undefined) lines.push(`retry: ${event.retry}`);
  if (event.id !== undefined) lines.push(`id: ${event.id}`);
  if (event.event !== undefined) lines.push(`event: ${event.event}`);
  if (event.data !== undefined) {
    const data = JSON.stringify(event.data);
    for (const line of data.split('\n')) lines.push(`data: ${line}`);
  }
  return `${lines.join('\n')}\n\n`;
}

export function publicJobEvent(job: JobRow): Omit<JobRow, 'payloadJson'> {
  const { payloadJson, ...safeJob } = job;
  void payloadJson;
  return safeJob;
}

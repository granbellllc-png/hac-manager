import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { JobLogLineRow, JobRow } from '../db/schema.js';
import type { DurableJobQueue } from '../jobs/queue.js';
import type { JobStatusEvent } from '../jobs/types.js';
import {
  encodeSseEvent,
  JobEventBroker,
  publicJobEvent,
} from './job-events.js';

describe('job event broker', () => {
  it('formats SSE fields and excludes persisted payloads from public job events', () => {
    expect(
      encodeSseEvent({
        comment: 'heartbeat',
        retry: 2000,
        id: 3,
        event: 'log',
        data: { text: 'line' },
      }),
    ).toBe(
      ': heartbeat\nretry: 2000\nid: 3\nevent: log\ndata: {"text":"line"}\n\n',
    );

    const job = {
      id: 'job',
      hostId: 'pve-01',
      vmid: 112,
      lane: 'guest',
      type: 'test',
      status: 'queued',
      priority: 0,
      payloadJson: '{"token":"***"}',
      triggeredBy: null,
      dependsOnJobId: null,
      timeoutMs: null,
      cancelRequestedAt: null,
      error: null,
      createdAt: new Date(),
      startedAt: null,
      finishedAt: null,
    } satisfies JobRow;
    expect(publicJobEvent(job)).not.toHaveProperty('payloadJson');
  });

  it('re-emits queue status/log events and sanitizes prompt data', () => {
    const queue = new EventEmitter() as DurableJobQueue;
    const broker = new JobEventBroker(queue);
    const jobListener = vi.fn();
    const logListener = vi.fn();
    const promptListener = vi.fn();
    broker.on('job', jobListener);
    broker.on('log', logListener);
    broker.on('prompt', promptListener);

    const job = {
      id: 'job',
      hostId: 'pve-01',
      vmid: null,
      lane: 'host',
      type: 'probe',
      status: 'running',
      priority: 0,
      payloadJson: null,
      triggeredBy: null,
      dependsOnJobId: null,
      timeoutMs: null,
      cancelRequestedAt: null,
      error: null,
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: null,
    } satisfies JobRow;
    queue.emit('status', {
      job,
      previousStatus: 'queued',
    } satisfies JobStatusEvent);
    const line = {
      jobId: 'job',
      seq: 1,
      ts: new Date(),
      stream: 'stdout',
      text: 'hello',
    } satisfies JobLogLineRow;
    queue.emit('log', line);
    broker.publishPrompt({
      id: 'prompt',
      jobId: 'job',
      hostId: 'pve-01',
      type: 'confirm',
      data: { password: 'fixture-secret' },
      createdAt: new Date().toISOString(),
    });

    expect(jobListener).toHaveBeenCalledWith(job);
    expect(logListener).toHaveBeenCalledWith(line);
    expect(promptListener).toHaveBeenCalledWith(
      expect.objectContaining({ data: { password: '***' } }),
    );
    broker.close();
    expect(queue.listenerCount('status')).toBe(0);
    expect(queue.listenerCount('log')).toBe(0);
  });
});

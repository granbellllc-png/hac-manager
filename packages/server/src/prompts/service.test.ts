import { afterEach, describe, expect, it, vi } from 'vitest';
import { globalSecretRedactor } from '@hacm/core';
import { createDatabase } from '../db/connection.js';
import { createSqliteRepositories } from '../db/repositories/sqlite.js';
import { DurableJobQueue } from '../jobs/queue.js';
import { JobEventBroker } from '../events/job-events.js';
import { PromptService } from './service.js';
import {
  PromptCancelledError,
  PromptExpiredError,
  PromptValidationError,
} from './types.js';

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('PromptService', () => {
  const queues: DurableJobQueue[] = [];

  afterEach(async () => {
    await Promise.all(
      queues.splice(0).map((queue) => queue.stop({ interruptRunning: true })),
    );
  });

  it('pauses a job, persists the prompt, resolves it, audits it, and resumes execution', async () => {
    const handle = createDatabase({ path: ':memory:' });
    try {
      const repos = createSqliteRepositories(handle.db);
      const queue = new DurableJobQueue(repos);
      queues.push(queue);
      const broker = new JobEventBroker(queue);
      const service = new PromptService(repos, broker);
      queue.setPromptHandler((job, request, signal) =>
        service.request({ ...request, jobId: job.id, signal }),
      );
      const promptEvents = vi.fn();
      broker.on('prompt', promptEvents);
      let resolution: unknown;
      queue.registerHandler('prompted', async (context) => {
        resolution = await context.prompt({
          id: `${context.job.id}:confirm`,
          kind: 'confirm',
          message: 'Continue?',
          payload: { token: 'should-not-persist' },
        });
      });
      const job = await queue.enqueue({
        id: 'prompt-job',
        hostId: 'pve-01',
        vmid: 112,
        type: 'prompted',
      });
      await queue.start();
      await waitUntil(
        async () => (await queue.get(job.id))?.status === 'waiting_input',
      );
      expect(await service.listPending()).toEqual([
        expect.objectContaining({
          id: 'prompt-job:confirm',
          status: 'pending',
          payload: { token: '***' },
        }),
      ]);

      await service.resolve(
        'prompt-job:confirm',
        { id: 'operator-1', username: 'operator' },
        { kind: 'confirm', confirmed: true },
      );
      await expect(queue.waitForJob(job.id)).resolves.toMatchObject({
        status: 'completed',
      });
      expect(resolution).toEqual({ kind: 'confirm', confirmed: true });
      expect(promptEvents).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'prompt.created' }),
      );
      expect(promptEvents).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'prompt.resolved' }),
      );
      expect(
        await repos.auditLogs.search({ action: 'prompt.resolve' }),
      ).toMatchObject({ total: 1 });
      broker.close();
    } finally {
      await Promise.all(
        queues.splice(0).map((queue) => queue.stop({ interruptRunning: true })),
      );
      handle.close();
    }
  });

  it('reattaches to a persisted prompt after a service restart', async () => {
    const handle = createDatabase({ path: ':memory:' });
    try {
      const repos = createSqliteRepositories(handle.db);
      const queue = new DurableJobQueue(repos);
      queues.push(queue);
      const broker = new JobEventBroker(queue);
      await repos.jobs.create({
        id: 'restart-job',
        hostId: 'pve-01',
        vmid: 112,
        lane: 'guest',
        type: 'test',
        status: 'waiting_input',
        priority: 0,
        createdAt: new Date(),
      });
      const firstService = new PromptService(repos, broker);
      const firstController = new AbortController();
      const firstWait = firstService.request({
        id: 'restart-prompt',
        jobId: 'restart-job',
        kind: 'choice',
        message: 'Choose one',
        options: ['host', 'rootfs'],
        signal: firstController.signal,
      });
      await waitUntil(
        async () => (await repos.prompts.get('restart-prompt')) !== null,
      );
      firstController.abort();
      await expect(firstWait).rejects.toBeInstanceOf(PromptCancelledError);

      const restartedService = new PromptService(repos, broker, (jobId) =>
        queue.resumeWaitingJob(jobId),
      );
      await restartedService.resolve(
        'restart-prompt',
        { id: 'admin', username: 'admin' },
        { kind: 'choice', choice: 'host' },
      );
      expect(await queue.get('restart-job')).toMatchObject({
        status: 'queued',
      });
      await expect(
        restartedService.request({
          id: 'restart-prompt',
          jobId: 'restart-job',
          kind: 'choice',
          message: 'Choose one',
          options: ['host', 'rootfs'],
        }),
      ).resolves.toEqual({ kind: 'choice', choice: 'host' });

      await repos.jobs.create({
        id: 'expired-restart-job',
        hostId: 'pve-01',
        vmid: 113,
        lane: 'guest',
        type: 'test',
        status: 'waiting_input',
        priority: 0,
        createdAt: new Date(),
      });
      await repos.prompts.create({
        id: 'expired-restart-prompt',
        jobId: 'expired-restart-job',
        kind: 'confirm',
        status: 'pending',
        message: 'Expired while offline',
        createdAt: new Date(Date.now() - 2_000),
        expiresAt: new Date(Date.now() - 1_000),
      });
      await expect(restartedService.expireDue()).resolves.toBe(1);
      expect(await queue.get('expired-restart-job')).toMatchObject({
        status: 'queued',
      });
      broker.close();
    } finally {
      handle.close();
    }
  });

  it('validates choices, typed confirmation, expiry, and request identity', async () => {
    const handle = createDatabase({ path: ':memory:' });
    try {
      const repos = createSqliteRepositories(handle.db);
      const queue = new DurableJobQueue(repos);
      queues.push(queue);
      const broker = new JobEventBroker(queue);
      const service = new PromptService(repos, broker);
      await repos.jobs.create({
        id: 'validation-job',
        hostId: 'pve-01',
        lane: 'host',
        type: 'test',
        status: 'waiting_input',
        priority: 0,
        createdAt: new Date(),
      });

      await expect(
        service.request({
          jobId: 'validation-job',
          kind: 'choice',
          message: '',
          options: ['a', 'b'],
        }),
      ).rejects.toBeInstanceOf(PromptValidationError);
      await expect(
        service.request({
          jobId: 'validation-job',
          kind: 'choice',
          message: 'Choose',
          options: ['only-one'],
        }),
      ).rejects.toThrow('at least two options');
      await expect(
        service.request({
          jobId: 'validation-job',
          kind: 'typed_confirmation',
          message: 'Type it',
        }),
      ).rejects.toThrow('expectedText');

      const controller = new AbortController();
      const typedWait = service.request({
        id: 'typed',
        jobId: 'validation-job',
        kind: 'typed_confirmation',
        message: 'Type DELETE',
        expectedText: 'DELETE',
        signal: controller.signal,
      });
      await waitUntil(async () => (await repos.prompts.get('typed')) !== null);
      await expect(
        service.resolve(
          'typed',
          { id: 'admin', username: 'admin' },
          { kind: 'confirm', confirmed: true },
        ),
      ).rejects.toThrow("cannot use 'confirm'");
      await expect(
        service.resolve(
          'typed',
          { id: 'admin', username: 'admin' },
          { kind: 'typed_confirmation', text: 'delete' },
        ),
      ).rejects.toThrow('does not match');
      await service.resolve(
        'typed',
        { id: 'admin', username: 'admin' },
        { kind: 'typed_confirmation', text: 'DELETE' },
      );
      await expect(typedWait).resolves.toEqual({
        kind: 'typed_confirmation',
        text: 'DELETE',
      });
      await expect(
        service.resolve(
          'typed',
          { id: 'admin', username: 'admin' },
          { kind: 'typed_confirmation', text: 'DELETE' },
        ),
      ).rejects.toThrow('already resolved');
      await expect(
        service.resolve(
          'missing',
          { id: 'admin', username: 'admin' },
          { kind: 'confirm', confirmed: true },
        ),
      ).rejects.toThrow("Prompt 'missing' not found");

      await expect(
        service.request({
          id: 'typed',
          jobId: 'different-job',
          kind: 'typed_confirmation',
          message: 'Type DELETE',
          expectedText: 'DELETE',
        }),
      ).rejects.toThrow('does not match the resumed request');

      const expired = service.request({
        id: 'expired',
        jobId: 'validation-job',
        kind: 'confirm',
        message: 'Too late',
        expiresAt: new Date(Date.now() + 10),
      });
      await expect(expired).rejects.toBeInstanceOf(PromptExpiredError);
      expect(await service.get('expired')).toMatchObject({ status: 'expired' });
      await expect(
        service.request({
          id: 'expired',
          jobId: 'validation-job',
          kind: 'confirm',
          message: 'Too late',
        }),
      ).rejects.toBeInstanceOf(PromptExpiredError);

      await repos.prompts.create({
        id: 'corrupt-resolution',
        jobId: 'validation-job',
        kind: 'confirm',
        status: 'resolved',
        message: 'Unreadable',
        resolutionJson: '{',
        createdAt: new Date(),
        resolvedAt: new Date(),
      });
      await expect(
        service.request({
          id: 'corrupt-resolution',
          jobId: 'validation-job',
          kind: 'confirm',
          message: 'Unreadable',
        }),
      ).rejects.toThrow('no readable resolution');

      globalSecretRedactor.register('fixture-confirmation-secret');
      try {
        await expect(
          service.request({
            id: 'secret-confirmation',
            jobId: 'validation-job',
            kind: 'typed_confirmation',
            message: 'Type the value',
            expectedText: 'fixture-confirmation-secret',
          }),
        ).rejects.toThrow('must not contain a resolved secret');
      } finally {
        globalSecretRedactor.unregister('fixture-confirmation-secret');
      }

      await repos.prompts.create({
        id: 'resolution-race',
        jobId: 'validation-job',
        kind: 'confirm',
        status: 'pending',
        message: 'Race',
        createdAt: new Date(),
      });
      const resolve = vi
        .spyOn(repos.prompts, 'resolve')
        .mockResolvedValueOnce(null);
      await expect(
        service.resolve(
          'resolution-race',
          { id: 'admin', username: 'admin' },
          { kind: 'confirm', confirmed: true },
        ),
      ).rejects.toThrow('resolved by another request');
      resolve.mockRestore();
      broker.close();
    } finally {
      handle.close();
    }
  });
});

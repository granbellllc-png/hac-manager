import { describe, expect, it, vi } from 'vitest';
import { Secret } from '@hacm/core';
import { createDatabase } from '../db/connection.js';
import { createSqliteRepositories } from '../db/repositories/sqlite.js';
import { createJobStepLogger, DatabaseStepJournal } from './step-journal.js';

describe('DatabaseStepJournal', () => {
  it('persists sanitized progress and reads legacy non-JSON results safely', async () => {
    const handle = createDatabase({ path: ':memory:' });
    try {
      const repos = createSqliteRepositories(handle.db);
      const now = new Date();
      await repos.jobs.create({
        id: 'job-steps',
        hostId: 'pve-01',
        vmid: 112,
        lane: 'guest',
        type: 'test',
        status: 'running',
        priority: 0,
        createdAt: now,
        startedAt: now,
      });
      const journal = new DatabaseStepJournal(repos);
      await journal.save({
        operationId: 'job-steps',
        stepIndex: 0,
        name: 'apply config',
        status: 'completed',
        result: {
          token: new Secret('fixture-secret'),
          nested: { password: 'literal-password' },
        },
        rollbackHint: 'Restore the previous config.',
        startedAt: now,
        finishedAt: new Date(now.getTime() + 1),
      });
      expect(await journal.list('job-steps')).toEqual([
        expect.objectContaining({
          status: 'completed',
          result: { token: '***', nested: { password: '***' } },
          rollbackHint: 'Restore the previous config.',
        }),
      ]);

      await repos.jobSteps.upsert({
        jobId: 'job-steps',
        stepIndex: 1,
        name: 'legacy',
        status: 'failed',
        resultJson: 'not-json',
      });
      expect((await journal.list('job-steps'))[1]).toMatchObject({
        result: 'not-json',
      });

      await journal.save({
        operationId: 'job-steps',
        stepIndex: 2,
        name: 'pending',
        status: 'pending',
      });
      expect((await journal.list('job-steps'))[2]).toEqual({
        operationId: 'job-steps',
        stepIndex: 2,
        name: 'pending',
        status: 'pending',
      });
    } finally {
      handle.close();
    }
  });

  it('adapts runner log levels to persisted job streams', async () => {
    const log = vi.fn(async () => undefined);
    const logger = createJobStepLogger(log);
    await logger.info('info');
    await logger.warn('careful');
    await logger.error('failed');
    expect(log.mock.calls).toEqual([
      ['system', 'info'],
      ['stderr', 'Warning: careful'],
      ['stderr', 'failed'],
    ]);
  });
});

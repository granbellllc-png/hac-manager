import { describe, expect, it } from 'vitest';
import { globalSecretRedactor } from '@hacm/core';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { createDatabase } from './connection.js';
import { createSqliteRepositories } from './repositories/sqlite.js';
import { jobLogLinesTable, jobStepsTable } from './schema.js';

describe('job repositories', () => {
  it('declares cascading foreign keys for logs and journal steps', () => {
    const logForeignKeys = getTableConfig(jobLogLinesTable).foreignKeys;
    const stepForeignKeys = getTableConfig(jobStepsTable).foreignKeys;
    expect(logForeignKeys).toHaveLength(1);
    expect(stepForeignKeys).toHaveLength(1);
    expect(logForeignKeys[0]?.reference().foreignColumns).toHaveLength(1);
    expect(stepForeignKeys[0]?.reference().foreignColumns).toHaveLength(1);
  });

  it('persists jobs, filters by target and status, and recovers running work', async () => {
    const handle = createDatabase({ path: ':memory:' });
    try {
      const repos = createSqliteRepositories(handle.db);
      const now = new Date('2026-01-01T00:00:00.000Z');
      await repos.jobs.create({
        id: 'normal',
        hostId: 'pve-01',
        vmid: 112,
        lane: 'guest',
        type: 'update',
        status: 'queued',
        priority: 0,
        createdAt: now,
      });
      await repos.jobs.create({
        id: 'power',
        hostId: 'pve-01',
        vmid: 112,
        lane: 'guest',
        type: 'power.stop',
        status: 'queued',
        priority: 100,
        createdAt: new Date(now.getTime() + 1),
      });
      await repos.jobs.create({
        id: 'host-job',
        hostId: 'pve-02',
        lane: 'host',
        type: 'probe',
        status: 'running',
        priority: 0,
        createdAt: now,
        startedAt: now,
      });

      expect((await repos.jobs.list()).map((job) => job.id)).toEqual([
        'power',
        'normal',
        'host-job',
      ]);
      expect(
        await repos.jobs.list({
          hostId: 'pve-01',
          vmid: 112,
          statuses: ['queued'],
          limit: 1,
        }),
      ).toHaveLength(1);
      expect(await repos.jobs.get('missing')).toBeNull();

      await expect(repos.jobs.claim('power', now)).resolves.toMatchObject({
        status: 'running',
        startedAt: now,
      });
      await expect(repos.jobs.claim('power', now)).resolves.toBeNull();
      await repos.jobs.updateStatus('power', 'completed', {
        finishedAt: now,
      });

      await expect(repos.jobs.requestCancel('normal', now)).resolves.toBe(true);
      expect((await repos.jobs.get('normal'))?.cancelRequestedAt).toEqual(now);
      await expect(
        repos.jobs.updateStatus('normal', 'running', {
          startedAt: now,
          error: null,
        }),
      ).resolves.toBe(true);
      await expect(
        repos.jobs.updateStatus('normal', 'completed', {
          finishedAt: now,
          cancelRequestedAt: null,
        }),
      ).resolves.toBe(true);

      await expect(repos.jobs.interruptRunning(now)).resolves.toBe(1);
      expect(await repos.jobs.get('host-job')).toMatchObject({
        status: 'interrupted',
        error: 'Backend restarted while the job was running',
      });
    } finally {
      handle.close();
    }
  });

  it('stores redacted line logs with stable sequence numbers and journal steps', async () => {
    const handle = createDatabase({ path: ':memory:' });
    globalSecretRedactor.register('fixture-super-secret');
    try {
      const repos = createSqliteRepositories(handle.db);
      const now = new Date('2026-01-01T00:00:00.000Z');
      await repos.jobs.create({
        id: 'job-1',
        hostId: 'pve-01',
        vmid: 112,
        lane: 'guest',
        type: 'test',
        status: 'queued',
        priority: 0,
        createdAt: now,
      });

      expect(
        await repos.jobLogLines.append({
          jobId: 'job-1',
          stream: 'stdout',
          text: 'token=fixture-super-secret',
          ts: now,
        }),
      ).toMatchObject({ seq: 1, text: 'token=***' });
      await repos.jobLogLines.append({
        jobId: 'job-1',
        stream: 'stderr',
        text: 'second',
        ts: new Date(now.getTime() + 1),
      });
      await repos.jobLogLines.append({
        jobId: 'job-1',
        stream: 'system',
        text: 'third',
        ts: new Date(now.getTime() + 2),
      });
      expect(
        await repos.jobLogLines.list('job-1', { afterSeq: 1, limit: 1 }),
      ).toEqual([expect.objectContaining({ seq: 2, text: 'second' })]);

      await repos.jobSteps.upsert({
        jobId: 'job-1',
        stepIndex: 0,
        name: 'check',
        status: 'running',
        startedAt: now,
      });
      await repos.jobSteps.upsert({
        jobId: 'job-1',
        stepIndex: 0,
        name: 'check',
        status: 'completed',
        resultJson: '{"ok":true}',
        rollbackHint: 'No rollback required',
        startedAt: now,
        finishedAt: new Date(now.getTime() + 3),
      });
      expect(await repos.jobSteps.list('job-1')).toEqual([
        expect.objectContaining({
          stepIndex: 0,
          status: 'completed',
          resultJson: '{"ok":true}',
        }),
      ]);
    } finally {
      globalSecretRedactor.unregister('fixture-super-secret');
      handle.close();
    }
  });
});

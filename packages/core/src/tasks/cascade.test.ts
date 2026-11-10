import { describe, expect, it } from 'vitest';
import type { ResolutionContext } from '../tags/types.js';
import { FakeTransport } from '../transport/fake.js';
import {
  parseTaskFailurePolicy,
  runTaskCascade,
  TaskCascadeError,
  type CascadeTier,
} from './cascade.js';
import { TaskRunError, type Task, type TaskResult } from './types.js';

const tagContext: ResolutionContext = { dataDir: '/data' };
const isShell = (argv: readonly string[]): boolean => argv[0] === '/bin/sh';

function task(name: string, overrides: Partial<Task> = {}): Task {
  return { name, run: `echo ${name}`, ...overrides };
}

function tier(
  number: 1 | 2 | 3,
  tasks: readonly Task[],
  transport: FakeTransport,
  extra: Partial<CascadeTier> = {},
): CascadeTier {
  return {
    tier: number,
    tasks,
    transport,
    tagContext,
    ...extra,
  };
}

const prerequisites = {
  fileSyncCompleted: true,
  identityVerified: true,
  invariantsVerified: true,
};

describe('runTaskCascade', () => {
  it('runs tiers in order and aggregates their results', async () => {
    const results: TaskResult[] = [];
    const tier1 = new FakeTransport().onExec(isShell, {});
    const tier2 = new FakeTransport().onExec(isShell, {});
    const tier3 = new FakeTransport().onExec(isShell, {});
    const result = await runTaskCascade({
      tiers: [
        tier(3, [task('guest-task')], tier3, {
          prerequisites,
          label: 'guest',
          onResult: (entry) => {
            results.push(entry);
          },
        }),
        tier(1, [task('global')], tier1, {
          targets: { groups: ['prod'] },
          host: { id: 'pve-01', groups: ['prod'] },
          label: 'global',
        }),
        tier(2, [task('host')], tier2, { label: 'host' }),
      ],
    });

    expect(result.tiers.map((entry) => entry.tier)).toEqual([1, 2, 3]);
    expect(result.tiers.map((entry) => entry.status)).toEqual([
      'ran',
      'ran',
      'ran',
    ]);
    expect(result.success).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.failed).toBe(0);
    expect(result.skippedTiers).toBe(0);
    expect(result.stopped).toBe(false);
    expect(result.failurePolicy).toBe('abort');
    expect(result.tiers[2]?.label).toBe('guest');
    expect(results.map((entry) => entry.name)).toEqual(['guest-task']);
  });

  it('skips empty, unmatched and unprepared tiers', async () => {
    const empty = await runTaskCascade({
      tiers: [tier(1, [], new FakeTransport())],
    });
    expect(empty.tiers[0]?.skipReason).toBe('empty');

    const unmatched = await runTaskCascade({
      tiers: [
        tier(1, [task('targeted')], new FakeTransport(), {
          targets: { tags: ['ssd'] },
          host: { id: 'pve-01', tags: ['hdd'] },
        }),
      ],
    });
    expect(unmatched.tiers[0]?.skipReason).toBe('target');

    const noHost = await runTaskCascade({
      tiers: [
        tier(1, [task('no-host')], new FakeTransport(), {
          targets: { groups: ['prod'] },
        }),
      ],
    });
    expect(noHost.tiers[0]?.skipReason).toBe('target');

    const unprepared = await runTaskCascade({
      tiers: [tier(3, [task('guest')], new FakeTransport())],
    });
    expect(unprepared.tiers[0]?.skipReason).toBe('prerequisites');
    expect(unprepared.tiers[0]?.results).toEqual([]);
    expect(unprepared.skippedTiers).toBe(1);
  });

  it('skips tiers below the resume point', async () => {
    const transport = new FakeTransport().onExec(isShell, {});
    const result = await runTaskCascade({
      tiers: [
        tier(1, [task('global')], new FakeTransport()),
        tier(2, [task('host')], new FakeTransport()),
        tier(3, [task('guest')], transport, { prerequisites }),
      ],
      resumeFrom: 3,
    });
    expect(result.tiers.map((entry) => entry.skipReason)).toEqual([
      'resume',
      'resume',
      undefined,
    ]);
    expect(result.tiers[2]?.status).toBe('ran');
    expect(result.changed).toBe(true);
  });

  it('aborts remaining tasks and tiers on the default policy', async () => {
    const first = new FakeTransport().onExec(isShell, {
      exitCode: 1,
      stderr: 'nope',
    });
    const later = new FakeTransport();
    const result = await runTaskCascade({
      tiers: [
        tier(1, [task('fail'), task('never')], first),
        tier(2, [task('later')], later),
      ],
    });
    expect(result.success).toBe(false);
    expect(result.failed).toBe(1);
    expect(result.stopped).toBe(true);
    expect(result.tiers[0]?.results.map((entry) => entry.name)).toEqual([
      'fail',
    ]);
    expect(result.tiers[1]?.status).toBe('skipped');
    expect(result.tiers[1]?.skipReason).toBe('aborted');
    expect(later.calls).toHaveLength(0);
  });

  it('abort-tier stops the failing tier but continues with the next one', async () => {
    const transport = new FakeTransport().onExec(isShell, { exitCode: 1 });
    const later = new FakeTransport().onExec(isShell, {});
    const result = await runTaskCascade({
      failurePolicy: 'abort-tier',
      tiers: [
        tier(1, [task('fail'), task('never')], transport),
        tier(2, [task('host')], later),
      ],
    });
    expect(result.failurePolicy).toBe('abort-tier');
    expect(result.success).toBe(false);
    expect(result.tiers[0]?.results.map((entry) => entry.name)).toEqual([
      'fail',
    ]);
    expect(result.tiers[1]?.status).toBe('ran');
    expect(result.stopped).toBe(false);
    expect(later.calls).toHaveLength(1);
  });

  it('continue runs every task and tier after a failure', async () => {
    const transport = new FakeTransport()
      .onExec(isShell, {})
      .onExec(isShell, { exitCode: 1 }, { once: true });
    const later = new FakeTransport().onExec(isShell, {});
    const result = await runTaskCascade({
      failurePolicy: 'continue',
      tiers: [
        tier(1, [task('fail'), task('next')], transport),
        tier(2, [task('host')], later),
      ],
    });
    expect(result.tiers[0]?.results.map((entry) => entry.name)).toEqual([
      'fail',
      'next',
    ]);
    expect(result.tiers[1]?.status).toBe('ran');
    expect(result.failed).toBe(1);
    expect(result.success).toBe(false);
  });

  it('does not treat ignore_errors as a tier failure', async () => {
    const transport = new FakeTransport().onExec(isShell, { exitCode: 1 });
    const later = new FakeTransport().onExec(isShell, {});
    const result = await runTaskCascade({
      tiers: [
        tier(1, [task('soft', { ignore_errors: true })], transport),
        tier(2, [task('host')], later),
      ],
    });
    expect(result.tiers[0]?.success).toBe(true);
    expect(result.tiers[1]?.status).toBe('ran');
    expect(result.success).toBe(true);
    expect(result.failed).toBe(0);
  });

  it('reports cancellation and skips every later tier', async () => {
    const controller = new AbortController();
    controller.abort();
    const first = new FakeTransport();
    const later = new FakeTransport().onExec(isShell, {});
    const result = await runTaskCascade({
      signal: controller.signal,
      tiers: [tier(1, [task('global')], first), tier(2, [task('host')], later)],
    });
    expect(result.cancelled).toBe(true);
    expect(result.success).toBe(false);
    expect(result.tiers[0]?.status).toBe('cancelled');
    expect(result.tiers[1]?.skipReason).toBe('aborted');
    expect(later.calls).toHaveLength(0);
  });

  it('lets a tier override the cascade signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const transport = new FakeTransport().onExec(isShell, {});
    const result = await runTaskCascade({
      signal: controller.signal,
      tiers: [tier(1, [task('global')], transport, { signal: undefined })],
    });
    // Undefined falls back to the cascade signal, so this remains cancelled.
    expect(result.cancelled).toBe(true);

    const fresh = new AbortController();
    const freshTransport = new FakeTransport().onExec(isShell, {});
    const resumed = await runTaskCascade({
      signal: controller.signal,
      tiers: [
        tier(1, [task('global')], freshTransport, { signal: fresh.signal }),
      ],
    });
    expect(resumed.cancelled).toBe(false);
    expect(resumed.tiers[0]?.status).toBe('ran');
  });

  it('rejects duplicate tiers', async () => {
    await expect(
      runTaskCascade({
        tiers: [
          tier(1, [task('a')], new FakeTransport()),
          tier(1, [task('b')], new FakeTransport()),
        ],
      }),
    ).rejects.toThrow(new TaskCascadeError('Tier 1 is configured twice.'));
  });
});

describe('parseTaskFailurePolicy', () => {
  it('accepts the documented policies and rejects anything else', () => {
    expect(parseTaskFailurePolicy('abort')).toBe('abort');
    expect(parseTaskFailurePolicy('abort-tier')).toBe('abort-tier');
    expect(parseTaskFailurePolicy('continue')).toBe('continue');
    expect(() => parseTaskFailurePolicy('stop')).toThrow(TaskRunError);
    expect(() => parseTaskFailurePolicy(undefined)).toThrow(
      /failure policy must be/,
    );
  });
});

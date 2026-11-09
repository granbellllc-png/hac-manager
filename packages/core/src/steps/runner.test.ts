import { describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '../transport/fake.js';
import { TransportFileNotFoundError } from '../transport/types.js';
import { MemoryStepJournal } from './memory-journal.js';
import { runJournaledSteps } from './runner.js';
import {
  StepExecutionError,
  StepJournalMismatchError,
  StepRunnerCancelledError,
  type JournaledStep,
  type StepLogger,
} from './types.js';

function logger() {
  const messages: string[] = [];
  const value: StepLogger = {
    info(message) {
      messages.push(`info:${message}`);
    },
    warn(message) {
      messages.push(`warn:${message}`);
    },
    error(message) {
      messages.push(`error:${message}`);
    },
  };
  return { value, messages };
}

async function fileEquals(
  transport: FakeTransport,
  path: string,
  expected: string,
) {
  try {
    return (await transport.readFile(path)) === expected;
  } catch (error) {
    if (error instanceof TransportFileNotFoundError) return false;
    throw error;
  }
}

describe('journaled step runner', () => {
  it('leaves a readable failed journal and safely resumes with FakeTransport', async () => {
    const transport = new FakeTransport();
    const journal = new MemoryStepJournal();
    const log = logger();
    let failSecondApply = true;
    const steps: readonly JournaledStep<{ value: string }>[] = [
      {
        name: 'prepare first file',
        check: async () => ({
          status: (await fileEquals(transport, '/first', 'ready'))
            ? 'satisfied'
            : 'required',
        }),
        apply: async ({ input, signal }) => {
          await transport.writeFile('/first', input.value, { signal });
          return { wrote: '/first' };
        },
        verify: async () => {
          if (!(await fileEquals(transport, '/first', 'ready'))) {
            throw new Error('first file missing');
          }
          return { verified: true };
        },
        rollbackHint: 'Remove /first if it is safe to do so.',
      },
      {
        name: 'prepare second file',
        check: async () => ({
          status: (await fileEquals(transport, '/second', 'ready'))
            ? 'satisfied'
            : 'required',
          detail: 'second-file-check',
        }),
        apply: async ({ input }) => {
          await transport.writeFile('/second', input.value);
          if (failSecondApply) {
            failSecondApply = false;
            throw new Error('fixture apply failure');
          }
          return { wrote: '/second' };
        },
        verify: async () => ({ verified: true }),
        rollbackHint: (_context, error) =>
          `Inspect /second after: ${String((error as Error).message)}`,
      },
      {
        name: 'final marker',
        check: async () => ({ status: 'required' }),
        apply: async ({ input }) => {
          await transport.writeFile('/final', input.value);
          return 'applied';
        },
        verify: async () => 'verified',
        rollbackHint: 'Remove /final.',
      },
    ];
    const base = {
      operationId: 'job-1',
      input: { value: 'ready' },
      transport,
      logger: log.value,
      dryRun: false,
      signal: new AbortController().signal,
      steps,
      journal,
    };

    await expect(runJournaledSteps(base)).rejects.toMatchObject({
      name: 'StepExecutionError',
      stepIndex: 1,
      rollbackHint: 'Inspect /second after: fixture apply failure',
    });
    expect(await journal.list('job-1')).toEqual([
      expect.objectContaining({ stepIndex: 0, status: 'completed' }),
      expect.objectContaining({
        stepIndex: 1,
        status: 'failed',
        rollbackHint: 'Inspect /second after: fixture apply failure',
      }),
    ]);

    const resumed = await runJournaledSteps(base);
    expect(resumed.entries).toEqual([
      expect.objectContaining({
        stepIndex: 0,
        status: 'completed',
        result: expect.objectContaining({ resumed: true }),
      }),
      expect.objectContaining({
        stepIndex: 1,
        status: 'completed',
        result: expect.objectContaining({ resumed: true }),
      }),
      expect.objectContaining({ stepIndex: 2, status: 'completed' }),
    ]);
    expect(transport.getFile('/final')).toBe('ready');
    expect(
      transport.calls.filter(
        (call) => call.kind === 'writeFile' && call.path === '/second',
      ),
    ).toHaveLength(1);
    expect(log.messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Step failed: prepare second file'),
        'info:Step already satisfied: prepare second file',
      ]),
    );
  });

  it('uses the same checks for dry-run without applying or verifying', async () => {
    const transport = new FakeTransport();
    const journal = new MemoryStepJournal();
    const log = logger();
    const apply = vi.fn(async () => undefined);
    const verify = vi.fn(async () => undefined);
    const result = await runJournaledSteps({
      operationId: 'dry-run',
      input: undefined,
      transport,
      logger: log.value,
      dryRun: true,
      signal: new AbortController().signal,
      journal,
      steps: [
        {
          name: 'would mutate',
          check: async () => ({
            status: 'required',
            detail: { reason: 'missing' },
          }),
          apply,
          verify,
          rollbackHint: 'No mutation occurred.',
        },
      ],
    });

    expect(result).toMatchObject({ operationId: 'dry-run', dryRun: true });
    expect(result.entries[0]).toMatchObject({
      status: 'skipped',
      result: { dryRun: true, wouldApply: true },
    });
    expect(apply).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    transport.assertNoMutations();
  });

  it('persists cancellation and propagates a typed cancellation error', async () => {
    const transport = new FakeTransport();
    const journal = new MemoryStepJournal();
    const log = logger();
    const controller = new AbortController();

    await expect(
      runJournaledSteps({
        operationId: 'cancelled',
        input: undefined,
        transport,
        logger: log.value,
        dryRun: false,
        signal: controller.signal,
        journal,
        steps: [
          {
            name: 'cancel during check',
            check: async () => {
              controller.abort('fixture cancellation');
              return { status: 'required' };
            },
            apply: async () => undefined,
            verify: async () => undefined,
            rollbackHint: 'No apply was started.',
          },
        ],
      }),
    ).rejects.toBeInstanceOf(StepRunnerCancelledError);
    expect(await journal.list('cancelled')).toEqual([
      expect.objectContaining({
        status: 'failed',
        result: { error: 'Step runner cancelled' },
      }),
    ]);
  });

  it('detects incompatible journals and protects rollback guidance failures', async () => {
    const transport = new FakeTransport();
    const log = logger();
    const unknownJournal = new MemoryStepJournal();
    await unknownJournal.save({
      operationId: 'unknown',
      stepIndex: 1,
      name: 'missing step',
      status: 'completed',
    });
    const base = {
      input: undefined,
      transport,
      logger: log.value,
      dryRun: false,
      signal: new AbortController().signal,
      steps: [
        {
          name: 'known step',
          check: async () => ({ status: 'required' as const }),
          apply: async () => {
            throw 'plain failure';
          },
          verify: async () => undefined,
          rollbackHint: () => {
            throw new Error('hint failure');
          },
        },
      ],
    };

    await expect(
      runJournaledSteps({
        ...base,
        operationId: 'unknown',
        journal: unknownJournal,
      }),
    ).rejects.toBeInstanceOf(StepJournalMismatchError);

    const renamedJournal = new MemoryStepJournal();
    await renamedJournal.save({
      operationId: 'renamed',
      stepIndex: 0,
      name: 'old name',
      status: 'completed',
    });
    await expect(
      runJournaledSteps({
        ...base,
        operationId: 'renamed',
        journal: renamedJournal,
      }),
    ).rejects.toThrow("runner defines 'known step'");

    await expect(
      runJournaledSteps({
        ...base,
        operationId: 'hint-failure',
        journal: new MemoryStepJournal(),
      }),
    ).rejects.toMatchObject({
      name: 'StepExecutionError',
      rollbackHint: 'Rollback guidance failed to render: hint failure',
      cause: 'plain failure',
    } satisfies Partial<StepExecutionError>);
  });
});

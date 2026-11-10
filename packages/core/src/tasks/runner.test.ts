import { describe, expect, it, vi } from 'vitest';
import type { TagValue } from '../schema/common.js';
import type { SecretProvider } from '../tags/types.js';
import { FakeTransport } from '../transport/fake.js';
import {
  TransportAbortedError,
  type ExecResult,
  type Transport,
} from '../transport/types.js';
import { buildTaskScript, runTasks, shellQuote } from './runner.js';
import { TaskRunError, type Task, type TaskResult } from './types.js';

const tag = (tagName: TagValue['tag'], value: string): TagValue => ({
  tag: tagName,
  value,
});

const context = {
  dataDir: '/data',
  env: { ENABLED: 'true' } as Record<string, string | undefined>,
};

const isShell = (argv: readonly string[]): boolean =>
  argv[0] === '/bin/sh' && argv[1] === '-s';

function task(overrides: Partial<Task> = {}): Task {
  return { name: 'main', run: 'echo hello', ...overrides };
}

function secretProvider(value: string | undefined): SecretProvider {
  return {
    resolveSecret: () =>
      value === undefined
        ? { status: 'not_found', reason: 'missing' }
        : { status: 'found', value },
  };
}

describe('script building', () => {
  it('quotes env values and appends the script on stdin', () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
    expect(
      buildTaskScript(task({ run: 'true' }), {
        FIRST: 'one',
        SECOND: "two's",
      }),
    ).toBe("export FIRST='one'\nexport SECOND='two'\\''s'\ntrue\n");
  });
});

describe('runTasks', () => {
  it('runs tasks in order and reports per-task results', async () => {
    const results: TaskResult[] = [];
    const transport = new FakeTransport().onExec(isShell, {
      stdout: 'done',
    });
    const summary = await runTasks({
      tasks: [
        task({ name: 'first', run: 'echo first' }),
        task({
          name: 'second',
          run: 'echo second',
          env: { MODE: 'prod' },
        }),
      ],
      transport,
      tagContext: context,
      onResult: (result) => {
        results.push(result);
      },
    });

    expect(summary.success).toBe(true);
    expect(summary.changed).toBe(true);
    expect(summary.failed).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.cancelled).toBe(false);
    expect(results.map((result) => result.name)).toEqual(['first', 'second']);
    const scripts = transport.calls
      .filter((call) => call.kind === 'exec')
      .map((call) => (call.kind === 'exec' ? call.options?.stdin : undefined));
    expect(scripts).toEqual([
      'echo first\n',
      "export MODE='prod'\necho second\n",
    ]);
    expect(results[0]).toMatchObject({
      status: 'success',
      changed: true,
      attempts: 1,
      exitCode: 0,
      timedOut: false,
      stdout: 'done',
    });
    expect(results[0]?.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(results[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('skips a task whose creates path already exists', async () => {
    const transport = new FakeTransport()
      .onExec('test -e /opt/installed', {})
      .onExec(isShell, {});
    const summary = await runTasks({
      tasks: [task({ creates: '/opt/installed' })],
      transport,
      tagContext: context,
    });
    expect(summary.results[0]).toMatchObject({
      status: 'skipped',
      skippedReason: 'creates',
      attempts: 0,
      changed: false,
    });
    expect(summary.skipped).toBe(1);
    expect(summary.changed).toBe(false);
    expect(
      transport.calls.some(
        (call) => call.kind === 'exec' && isShell(call.argv),
      ),
    ).toBe(false);
  });

  it('runs a task when the creates check fails', async () => {
    const transport = new FakeTransport()
      .onExec('test -e /opt/installed', { exitCode: 1 })
      .onExec(isShell, {});
    const summary = await runTasks({
      tasks: [task({ creates: '/opt/installed' })],
      transport,
      tagContext: context,
    });
    expect(summary.results[0]?.status).toBe('success');
  });

  it('evaluates literal, expression-tag and env-tag conditions', async () => {
    const transport = new FakeTransport().onExec(isShell, {});
    const summary = await runTasks({
      tasks: [
        task({ name: 'yes', when: '1 == 1' }),
        task({ name: 'no', when: '1 == 2' }),
        task({ name: 'expr-yes', when: tag('expr', '1') }),
        task({ name: 'expr-no', when: tag('expr', '0') }),
        task({ name: 'env-yes', when: tag('env', 'ENABLED') }),
      ],
      transport,
      tagContext: context,
    });
    expect(
      summary.results.map((result) => [result.name, result.status]),
    ).toEqual([
      ['yes', 'success'],
      ['no', 'skipped'],
      ['expr-yes', 'success'],
      ['expr-no', 'skipped'],
      ['env-yes', 'success'],
    ]);
    expect(summary.results[1]?.skippedReason).toBe('when');
  });

  it('retries a failing task and reports the successful attempt', async () => {
    const transport = new FakeTransport()
      .onExec(isShell, { stdout: 'ok' })
      .onExec(isShell, { exitCode: 1 }, { once: true });
    const summary = await runTasks({
      tasks: [task({ retries: 2 })],
      transport,
      tagContext: context,
    });
    expect(summary.results[0]).toMatchObject({
      status: 'success',
      attempts: 2,
      exitCode: 0,
    });
  });

  it('reports a failed task after exhausting retries', async () => {
    const transport = new FakeTransport()
      .onExec(isShell, { exitCode: 7, stderr: 'boom' }, { once: true })
      .onExec(isShell, { exitCode: 7, stderr: 'boom' }, { once: true });
    const summary = await runTasks({
      tasks: [task({ retries: 1 })],
      transport,
      tagContext: context,
    });
    expect(summary.success).toBe(false);
    expect(summary.failed).toBe(1);
    expect(summary.results[0]).toMatchObject({
      status: 'failed',
      attempts: 2,
      exitCode: 7,
      stderr: 'boom',
    });
    expect(summary.results[0]?.error).toContain('exited with code 7');
  });

  it('reports a timeout as timed_out', async () => {
    const transport = new FakeTransport().onExec(isShell, {
      exitCode: 0,
      timedOut: true,
    });
    const summary = await runTasks({
      tasks: [task({ timeout: 5 })],
      transport,
      tagContext: context,
    });
    expect(summary.results[0]).toMatchObject({
      status: 'timed_out',
      timedOut: true,
    });
    expect(summary.failed).toBe(1);
    expect(summary.results[0]?.error).toContain('timed out after 5s');
  });

  it('honours ignore_errors while keeping the failure detail', async () => {
    const transport = new FakeTransport().onExec(isShell, { exitCode: 2 });
    const summary = await runTasks({
      tasks: [task({ ignore_errors: true })],
      transport,
      tagContext: context,
    });
    expect(summary.results[0]?.status).toBe('ignored');
    expect(summary.success).toBe(true);
    expect(summary.failed).toBe(0);
  });

  it('triggers onchange tasks once after a change', async () => {
    const transport = new FakeTransport().onExec(isShell, {});
    const summary = await runTasks({
      tasks: [
        task({ name: 'a', onchange: ['b', 'missing'] }),
        task({ name: 'b', onchange: ['a'] }),
      ],
      transport,
      tagContext: context,
    });
    expect(summary.results.map((result) => result.name)).toEqual([
      'a',
      'b',
      'missing',
    ]);
    const b = summary.results.find((result) => result.name === 'b');
    expect(b?.status).toBe('success');
    expect(summary.results.at(-1)).toMatchObject({
      name: 'missing',
      status: 'failed',
    });
    expect(summary.results.at(-1)?.error).toContain(
      "Task 'a' triggers unknown task 'missing'",
    );
  });

  it('does not trigger onchange tasks for skipped or failed tasks', async () => {
    const transport = new FakeTransport().onExec(isShell, { exitCode: 1 });
    const summary = await runTasks({
      tasks: [
        task({ name: 'skip', when: 'false', onchange: ['next'] }),
        task({ name: 'fail', onchange: ['next'] }),
        task({ name: 'next' }),
      ],
      transport,
      tagContext: context,
    });
    expect(summary.results.map((result) => result.name)).toEqual([
      'skip',
      'fail',
      'next',
    ]);
  });

  it('rejects duplicate task names', async () => {
    await expect(
      runTasks({
        tasks: [task({ name: 'same' }), task({ name: 'same' })],
        transport: new FakeTransport(),
        tagContext: context,
      }),
    ).rejects.toThrow(new TaskRunError("Duplicate task name 'same'."));
  });

  it('injects a secret env value and redacts it from output', async () => {
    const transport = new FakeTransport().onExec(isShell, {
      stdout: 'token is supersecret',
      stderr: 'supersecret leaked',
    });
    const summary = await runTasks({
      tasks: [task({ env: { TOKEN: tag('secret', 'app/token') } })],
      transport,
      tagContext: {
        ...context,
        secretProvider: secretProvider('supersecret'),
      },
    });
    expect(summary.results[0]?.status).toBe('success');
    expect(summary.results[0]?.stdout).toBe('token is ***');
    expect(summary.results[0]?.stderr).toBe('*** leaked');
    const call = transport.calls.find(
      (entry) => entry.kind === 'exec' && isShell(entry.argv),
    );
    expect(call?.kind === 'exec' ? call.options?.stdin : '').toContain(
      "export TOKEN='supersecret'",
    );
  });

  it('rejects secrets in non-env computed fields', async () => {
    const summary = await runTasks({
      tasks: [task({ when: tag('secret', 'flag') })],
      transport: new FakeTransport(),
      tagContext: {
        ...context,
        secretProvider: secretProvider('supersecret'),
      },
    });
    expect(summary.results[0]?.status).toBe('failed');
    expect(summary.results[0]?.error).toContain(
      'when must not resolve to a secret',
    );
  });

  it('reports unresolved tags and invalid field values per task', async () => {
    const transport = new FakeTransport();
    const summary = await runTasks({
      tasks: [
        task({ name: 'missing-env', env: { TOKEN: tag('env', 'MISSING') } }),
        task({ name: 'missing-when', when: tag('env', 'MISSING') }),
        task({ name: 'bad-name', env: { 'BAD-NAME': 'x' } }),
        task({ name: 'nul', env: { OK: 'a\u0000b' } }),
        task({ name: 'bad-timeout', timeout: 0 }),
        task({ name: 'bad-retries', retries: -1 }),
      ],
      transport,
      tagContext: context,
    });
    expect(summary.results.map((result) => result.status)).toEqual([
      'failed',
      'failed',
      'failed',
      'failed',
      'failed',
      'failed',
    ]);
    expect(summary.results[0]?.error).toContain(
      "Cannot resolve env.TOKEN tag '!env MISSING'",
    );
    expect(summary.results[1]?.error).toContain(
      "Cannot resolve when tag '!env MISSING'",
    );
    expect(summary.results[2]?.error).toContain(
      "env variable 'BAD-NAME' is not a valid environment name",
    );
    expect(summary.results[3]?.error).toContain('must not contain NUL');
    expect(summary.results[4]?.error).toContain(
      'timeout must be an integer of at least 1',
    );
    expect(summary.results[5]?.error).toContain(
      'retries must be an integer of at least 0',
    );
  });

  it('rejects a shell with arguments', async () => {
    const summary = await runTasks({
      tasks: [task({ shell: '/bin/sh -x' })],
      transport: new FakeTransport(),
      tagContext: context,
    });
    expect(summary.results[0]?.status).toBe('failed');
    expect(summary.results[0]?.error).toContain('without arguments');
  });

  it('uses a custom interpreter', async () => {
    const transport = new FakeTransport().onExec(
      (argv) => argv[0] === '/bin/bash' && argv[1] === '-s',
      {},
    );
    const summary = await runTasks({
      tasks: [task({ shell: '/bin/bash' })],
      transport,
      tagContext: context,
    });
    expect(summary.results[0]?.status).toBe('success');
  });

  it('fails a task whose when expression cannot be evaluated', async () => {
    const summary = await runTasks({
      tasks: [task({ when: '1 +' })],
      transport: new FakeTransport(),
      tagContext: context,
    });
    expect(summary.results[0]?.status).toBe('failed');
    expect(summary.results[0]?.error).toContain("Cannot evaluate when '1 +'");
  });

  it('reports a transport error as a failed task', async () => {
    const transport = new FakeTransport();
    transport.exec = async () => {
      throw new Error('connection lost');
    };
    const summary = await runTasks({
      tasks: [task()],
      transport,
      tagContext: context,
    });
    expect(summary.results[0]).toMatchObject({
      status: 'failed',
      exitCode: null,
    });
    expect(summary.results[0]?.error).toBe('connection lost');
  });

  it('stops before running when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const transport = new FakeTransport();
    const summary = await runTasks({
      tasks: [task()],
      transport,
      tagContext: context,
      signal: controller.signal,
    });
    expect(summary.cancelled).toBe(true);
    expect(summary.results[0]?.status).toBe('cancelled');
    expect(summary.results[0]?.error).toBe('Task was cancelled.');
    expect(transport.calls).toHaveLength(0);
  });

  it('reports cancellation raised by the transport', async () => {
    const transport = new FakeTransport();
    transport.exec = async () => {
      throw new TransportAbortedError();
    };
    const summary = await runTasks({
      tasks: [task()],
      transport,
      tagContext: context,
      signal: new AbortController().signal,
    });
    expect(summary.cancelled).toBe(true);
    expect(summary.results[0]?.status).toBe('cancelled');
  });

  it('stops after the first cancelled task', async () => {
    let calls = 0;
    const transport: Transport = {
      exec: async (): Promise<ExecResult> => {
        calls += 1;
        throw new TransportAbortedError();
      },
      readFile: async () => '',
      writeFile: async () => undefined,
    };
    const summary = await runTasks({
      tasks: [task({ name: 'a' }), task({ name: 'b' })],
      transport,
      tagContext: context,
      signal: new AbortController().signal,
    });
    expect(summary.results).toHaveLength(1);
    expect(summary.cancelled).toBe(true);
    expect(calls).toBe(1);
  });

  it('truncates oversized output', async () => {
    const transport = new FakeTransport().onExec(isShell, {
      stdout: 'x'.repeat(200),
      stderr: 'y'.repeat(200),
    });
    const summary = await runTasks({
      tasks: [task()],
      transport,
      tagContext: context,
      maxOutputChars: 10,
    });
    expect(summary.results[0]?.stdout).toBe('xxxxxxxxxx\n… [truncated]');
    expect(summary.results[0]?.stderr).toBe('yyyyyyyyyy\n… [truncated]');
  });

  it('uses injected clocks and defaults for optional execution settings', async () => {
    const dates = [
      new Date('2026-11-10T00:00:00.000Z'),
      new Date('2026-11-10T00:00:01.500Z'),
    ];
    const now = vi.fn(() => dates.shift() ?? new Date());
    const transport = new FakeTransport().onExec(isShell, {});
    const summary = await runTasks({
      tasks: [task()],
      transport,
      tagContext: context,
      now,
      defaultTimeoutSeconds: 30,
    });
    expect(summary.results[0]).toMatchObject({
      startedAt: '2026-11-10T00:00:00.000Z',
      finishedAt: '2026-11-10T00:00:01.500Z',
      durationMs: 1500,
    });
  });
});

describe('runTasks edge paths', () => {
  it('evaluates string-valued when results with shell truthiness', async () => {
    const transport = new FakeTransport().onExec(isShell, {});
    const summary = await runTasks({
      tasks: [
        task({ name: 'one', when: "'1'" }),
        task({ name: 'zero', when: "'0'" }),
        task({ name: 'false', when: "'false'" }),
        task({ name: 'blank', when: "'   '" }),
        task({ name: 'yes', when: "'yes'" }),
        task({ name: 'number', when: tag('expr', '1') }),
        task({ name: 'list', when: tag('expr', 'items') }),
      ],
      transport,
      tagContext: {
        ...context,
        evaluationContext: { items: ['a'] },
      },
    });
    expect(
      summary.results.map((result) => [result.name, result.status]),
    ).toEqual([
      ['one', 'success'],
      ['zero', 'skipped'],
      ['false', 'skipped'],
      ['blank', 'skipped'],
      ['yes', 'success'],
      ['number', 'success'],
      ['list', 'success'],
    ]);
  });

  it('reports tag-provider errors and accepts string tag values', async () => {
    const transport = new FakeTransport().onExec(isShell, {});
    const summary = await runTasks({
      tasks: [
        task({ name: 'when-error', when: tag('cmd', 'forbidden') }),
        task({
          name: 'env-error',
          env: { VALUE: tag('cmd', 'forbidden') },
        }),
        task({ name: 'string-timeout', timeout: tag('env', 'TIMEOUT') }),
        task({ name: 'fractional-timeout', timeout: 1.5 }),
      ],
      transport,
      tagContext: {
        ...context,
        env: { ...context.env, TIMEOUT: '5' },
        cmdProvider: {
          resolveCmd: () => ({ status: 'not_allowed', reason: 'denied' }),
        },
      },
    });
    expect(summary.results[0]?.error).toContain(
      "Command 'forbidden' is not allowed by admin allowlist: denied",
    );
    expect(summary.results[1]?.error).toContain(
      "Command 'forbidden' is not allowed by admin allowlist: denied",
    );
    expect(summary.results[2]?.status).toBe('success');
    expect(summary.results[3]?.error).toContain(
      'timeout must be an integer of at least 1',
    );
  });

  it('passes the signal to the creates check', async () => {
    const transport = new FakeTransport()
      .onExec('test -e /opt/installed', { exitCode: 1 })
      .onExec(isShell, {});
    const summary = await runTasks({
      tasks: [task({ creates: '/opt/installed' })],
      transport,
      tagContext: context,
      signal: new AbortController().signal,
    });
    expect(summary.results[0]?.status).toBe('success');
    const check = transport.calls.find(
      (call) => call.kind === 'exec' && call.argv[0] === 'test',
    );
    expect(
      check?.kind === 'exec' ? check.options?.signal : undefined,
    ).toBeDefined();
  });

  it('reports a non-Error failure from the creates check', async () => {
    const transport = new FakeTransport();
    transport.exec = async (argv) => {
      if (argv[0] === 'test') throw 42;
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    };
    const summary = await runTasks({
      tasks: [task({ creates: '/opt/installed' })],
      transport,
      tagContext: context,
    });
    expect(summary.results[0]).toMatchObject({ status: 'failed', error: '42' });
  });
});

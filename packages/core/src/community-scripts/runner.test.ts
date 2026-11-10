import { describe, expect, it } from 'vitest';
import { SecretRedactor } from '../redaction/index.js';
import type { CachedCommunityScript } from './types.js';
import {
  communityScriptEnv,
  detectCommunityScriptCtid,
  runCommunityScript,
  ScriptEnvironmentError,
  startCommunityScript,
  type CommunityScriptRunOptions,
  type ScriptProcess,
  type ScriptProcessExit,
  type ScriptProcessFactory,
  type ScriptSpawnOptions,
} from './runner.js';
import { ScriptPromptStateError } from './prompts.js';

const script: CachedCommunityScript = {
  url: `https://example.test/install.sh/${'a'.repeat(40)}`,
  key: 'example',
  content: '#!/usr/bin/env bash\necho hi\n',
  hash: 'b'.repeat(64),
  fetchedAt: new Date(0).toISOString(),
};

class FakeProcess implements ScriptProcess {
  public readonly writes: string[] = [];
  public readonly kills: string[] = [];
  private readonly dataListeners: ((chunk: string) => void)[] = [];
  private readonly exitListeners: ((event: ScriptProcessExit) => void)[] = [];

  public write(data: string): void {
    this.writes.push(data);
  }

  public kill(signal?: 'SIGTERM' | 'SIGKILL'): void {
    this.kills.push(signal ?? 'SIGTERM');
  }

  public onData(listener: (chunk: string) => void): () => void {
    this.dataListeners.push(listener);
    return () => {};
  }

  public onExit(listener: (event: ScriptProcessExit) => void): () => void {
    this.exitListeners.push(listener);
    return () => {};
  }

  public emitData(chunk: string): void {
    for (const listener of this.dataListeners) listener(chunk);
  }

  public emitExit(event: ScriptProcessExit): void {
    for (const listener of this.exitListeners) listener(event);
  }
}

class FakeFactory implements ScriptProcessFactory {
  public readonly process = new FakeProcess();
  public spawns = 0;
  public lastOptions: ScriptSpawnOptions | undefined;
  public throwOnSpawn: Error | undefined;

  public spawn(options: ScriptSpawnOptions): ScriptProcess {
    this.spawns += 1;
    this.lastOptions = options;
    if (this.throwOnSpawn) throw this.throwOnSpawn;
    return this.process;
  }
}

const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

function options(
  factory: FakeFactory,
  overrides: Partial<CommunityScriptRunOptions> = {},
): CommunityScriptRunOptions {
  return {
    script,
    guest: { ctid: 123 },
    processFactory: factory,
    timeoutMs: 60_000,
    ...overrides,
  };
}

describe('communityScriptEnv', () => {
  it('maps guest settings to the variables helper scripts expect', () => {
    expect(
      communityScriptEnv({
        ctid: 123,
        hostname: 'demo',
        unprivileged: true,
        cpu: 2,
        ram: 2048,
        disk: 8,
        bridge: 'vmbr1',
        net: 'AA:BB:CC:DD:EE:FF',
        ssh: true,
        ostype: 'ubuntu',
        storage: 'local-lvm',
        extra: { var_version: '24.04', var_nesting: 1 },
      }),
    ).toEqual({
      TERM: 'xterm',
      var_ctid: '123',
      var_hostname: 'demo',
      var_unprivileged: '1',
      var_cpu: '2',
      var_ram: '2048',
      var_disk: '8',
      var_brg: 'vmbr1',
      var_net: 'AA:BB:CC:DD:EE:FF',
      var_ssh: 'yes',
      var_os: 'ubuntu',
      var_storage: 'local-lvm',
      var_version: '24.04',
      var_nesting: '1',
    });
  });

  it('uses the disabled conventions for false flags', () => {
    const env = communityScriptEnv({
      ctid: 100,
      unprivileged: false,
      ssh: false,
    });
    expect(env.var_unprivileged).toBe('0');
    expect(env.var_ssh).toBe('no');
  });

  it('rejects invalid CTIDs and variables', () => {
    expect(() => communityScriptEnv({ ctid: 99 })).toThrow(
      ScriptEnvironmentError,
    );
    expect(() => communityScriptEnv({ ctid: 1.5 })).toThrow(/integer/);
    expect(() =>
      communityScriptEnv({ ctid: 100, extra: { 'bad-name': 'x' } }),
    ).toThrow(/valid environment name/);
    expect(() =>
      communityScriptEnv({ ctid: 100, extra: { TERM: 'dumb' } }),
    ).toThrow(/valid environment name/);
    expect(() =>
      communityScriptEnv({ ctid: 100, cpu: Number.POSITIVE_INFINITY }),
    ).toThrow(/not finite/);
    expect(() =>
      communityScriptEnv({ ctid: 100, extra: { var_bad: 'a\u0000b' } }),
    ).toThrow(/NUL/);
  });
});

describe('detectCommunityScriptCtid', () => {
  it('reads CTIDs from common script output', () => {
    expect(detectCommunityScriptCtid('CTID: 123')).toBe(123);
    expect(detectCommunityScriptCtid('Container ID = 456')).toBe(456);
    expect(detectCommunityScriptCtid('Creating CT 789...')).toBe(789);
    expect(
      detectCommunityScriptCtid('\u001B[32mstarting container 321\u001B[0m'),
    ).toBe(321);
  });

  it('returns undefined when no plausible CTID is present', () => {
    expect(detectCommunityScriptCtid('nothing to see')).toBeUndefined();
    expect(detectCommunityScriptCtid('CTID: 99')).toBeUndefined();
    expect(detectCommunityScriptCtid('CTID: not-a-number')).toBeUndefined();
  });

  it('supports custom patterns', () => {
    expect(detectCommunityScriptCtid('guest=777', [/\bguest=(\d+)\b/])).toBe(
      777,
    );
  });
});

describe('startCommunityScript', () => {
  it('spawns with injected environment and reports the created CTID', async () => {
    const factory = new FakeFactory();
    const run = startCommunityScript(
      options(factory, {
        guest: {
          ctid: 123,
          hostname: 'demo',
          unprivileged: true,
          cpu: 2,
          ram: 1024,
          disk: 4,
          bridge: 'vmbr0',
          net: 'AA:BB',
          ssh: true,
        },
        env: { var_version: '24.04' },
      }),
    );
    await tick();
    expect(factory.spawns).toBe(1);
    expect(factory.lastOptions?.script).toBe(script);
    expect(factory.lastOptions?.env).toMatchObject({
      TERM: 'xterm',
      var_ctid: '123',
      var_hostname: 'demo',
      var_unprivileged: '1',
      var_version: '24.04',
    });
    expect(factory.lastOptions?.cols).toBe(120);
    expect(factory.lastOptions?.rows).toBe(40);

    factory.process.emitData('Creating CT 123...\n');
    factory.process.emitData('Done\n');
    factory.process.emitExit({ exitCode: 0 });
    await expect(run.done).resolves.toEqual({
      status: 'completed',
      exitCode: 0,
      ctid: 123,
      logs: ['Creating CT 123...', 'Done'],
    });
  });

  it('never lets callers override TERM or use invalid variable names', async () => {
    const factory = new FakeFactory();
    startCommunityScript(
      options(factory, { env: { TERM: 'dumb', var_ok: 'yes' } }),
    );
    await tick();
    expect(factory.lastOptions?.env.TERM).toBe('xterm');
    expect(factory.lastOptions?.env.var_ok).toBe('yes');

    const invalid = new FakeFactory();
    const failed = startCommunityScript(
      options(invalid, { env: { 'bad name': 'x' } }),
    );
    await expect(failed.done).resolves.toMatchObject({
      status: 'failed',
      error: expect.stringContaining('valid environment name'),
    });
    expect(invalid.spawns).toBe(0);
  });

  it('fails cleanly when the guest environment is invalid', async () => {
    const factory = new FakeFactory();
    const run = startCommunityScript(options(factory, { guest: { ctid: 1 } }));
    await expect(run.done).resolves.toMatchObject({
      status: 'failed',
      exitCode: null,
    });
    expect(factory.spawns).toBe(0);
  });

  it('answers configured prompts', async () => {
    const factory = new FakeFactory();
    const run = startCommunityScript(
      options(factory, {
        answers: { 'Enter the hostname:': 'demo', 'Continue\\?': '' },
      }),
    );
    await tick();
    factory.process.emitData('Enter the hostname: ');
    expect(factory.process.writes).toEqual(['demo\n']);
    factory.process.emitData('Continue? ');
    expect(factory.process.writes).toEqual(['demo\n', '\n']);
    factory.process.emitExit({ exitCode: 0 });
    await expect(run.done).resolves.toMatchObject({ status: 'completed' });
  });

  it('pauses on an unexpected prompt and resumes with a user answer', async () => {
    const factory = new FakeFactory();
    const redactor = new SecretRedactor();
    const run = startCommunityScript(
      options(factory, {
        redactor,
        secrets: ['hunter2'],
      }),
    );
    await tick();
    factory.process.emitData('Token hunter2:');
    const waiting = await run.done;
    expect(waiting).toMatchObject({
      status: 'waiting_input',
      prompt: { question: 'Token ***:' },
      logs: ['Token ***:'],
    });
    if (waiting.status !== 'waiting_input') throw new Error('unreachable');

    run.answer('resolved-token');
    const next = run.done;
    expect(factory.process.writes).toEqual(['resolved-token\n']);
    factory.process.emitData('Installed\n');
    factory.process.emitExit({ exitCode: 0 });
    await expect(next).resolves.toMatchObject({
      status: 'completed',
      logs: ['Token ***:', 'Installed'],
    });
    expect(waiting.logs).toEqual(['Token ***:']);
  });

  it('rejects answering with no pending prompt or after cancellation', async () => {
    const factory = new FakeFactory();
    const run = startCommunityScript(options(factory));
    await tick();
    expect(() => run.answer('x')).toThrow(ScriptPromptStateError);

    factory.process.emitData('Continue?');
    await run.done;
    run.cancel();
    expect(() => run.answer('x')).toThrow(/no longer running/);
  });

  it('reports a failure when the script exits while waiting for input', async () => {
    const factory = new FakeFactory();
    const run = startCommunityScript(options(factory));
    await tick();
    factory.process.emitData('Continue?');
    await run.done;
    factory.process.emitExit({ exitCode: 2 });
    run.answer('y');
    await expect(run.done).resolves.toMatchObject({
      status: 'failed',
      exitCode: 2,
    });
    expect(factory.process.writes).toEqual([]);
  });

  it('fails with a non-zero exit code and signal', async () => {
    const factory = new FakeFactory();
    const run = startCommunityScript(options(factory));
    await tick();
    factory.process.emitData('boom\n');
    factory.process.emitExit({ exitCode: 1, signal: 'SIGTERM' });
    await expect(run.done).resolves.toMatchObject({
      status: 'failed',
      exitCode: 1,
      error: expect.stringContaining('signal SIGTERM'),
    });
  });

  it('reports a null exit code', async () => {
    const factory = new FakeFactory();
    const run = startCommunityScript(options(factory));
    await tick();
    factory.process.emitExit({ exitCode: null });
    await expect(run.done).resolves.toMatchObject({
      status: 'failed',
      exitCode: null,
    });
  });

  it('times out and kills the script', async () => {
    const factory = new FakeFactory();
    const run = startCommunityScript(options(factory, { timeoutMs: 5 }));
    await expect(run.done).resolves.toEqual({ status: 'timed_out', logs: [] });
    expect(factory.process.kills).toEqual(['SIGKILL']);
  });

  it('cancels through an AbortSignal', async () => {
    const factory = new FakeFactory();
    const controller = new AbortController();
    const run = startCommunityScript(
      options(factory, { signal: controller.signal }),
    );
    await tick();
    controller.abort();
    await expect(run.done).resolves.toEqual({ status: 'cancelled', logs: [] });
    expect(factory.process.kills).toEqual(['SIGKILL']);
  });

  it('cancels before spawning when already aborted', async () => {
    const factory = new FakeFactory();
    const controller = new AbortController();
    controller.abort();
    const run = startCommunityScript(
      options(factory, { signal: controller.signal }),
    );
    await expect(run.done).resolves.toEqual({ status: 'cancelled', logs: [] });
    expect(factory.spawns).toBe(0);
  });

  it('fails when the process factory throws', async () => {
    const factory = new FakeFactory();
    factory.throwOnSpawn = new Error('pty unavailable');
    const run = startCommunityScript(options(factory));
    await expect(run.done).resolves.toMatchObject({
      status: 'failed',
      exitCode: null,
      error: expect.stringContaining('pty unavailable'),
    });
  });

  it('streams redacted lines and survives a throwing log sink', async () => {
    const factory = new FakeFactory();
    const lines: string[] = [];
    const redactor = new SecretRedactor();
    redactor.register('hunter2');
    const run = startCommunityScript(
      options(factory, {
        redactor,
        onLine: (line) => {
          lines.push(line);
          throw new Error('sink failure');
        },
      }),
    );
    await tick();
    factory.process.emitData('one hunter2\npart');
    factory.process.emitData('ial\r\n');
    factory.process.emitData('\n');
    factory.process.emitExit({ exitCode: 0 });
    await expect(run.done).resolves.toMatchObject({
      status: 'completed',
      logs: ['one ***', 'partial'],
    });
    expect(lines).toEqual(['one ***', 'partial']);
  });

  it('flushes a partial prompt line before pausing', async () => {
    const factory = new FakeFactory();
    const run = startCommunityScript(options(factory));
    await tick();
    factory.process.emitData('Progress\nQuestion:');
    await expect(run.done).resolves.toMatchObject({
      status: 'waiting_input',
      prompt: { question: 'Question:' },
      logs: ['Progress', 'Question:'],
    });
  });

  it('runs to completion through the convenience helper', async () => {
    const factory = new FakeFactory();
    const promise = runCommunityScript(options(factory));
    await tick();
    factory.process.emitExit({ exitCode: 0 });
    await expect(promise).resolves.toMatchObject({ status: 'completed' });
  });
});

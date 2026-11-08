import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FakeTransport,
  RecordingTransport,
  TransportAbortedError,
  TransportFileNotFoundError,
  runMutation,
  type ExecutorContext,
} from '../index.js';

function readFixture(name: string): string {
  return readFileSync(
    resolve(import.meta.dirname, '../../fixtures/proxmox', name),
    'utf8',
  );
}

describe('FakeTransport', () => {
  it('runs a fake `pct config 112` through the transport', async () => {
    const transport = new FakeTransport().onExec('pct config 112', {
      stdout: readFixture('lxc-112-unprivileged.conf'),
    });
    const result = await transport.exec(['pct', 'config', '112']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hostname: example-lxc');
    expect(result.stdout).toContain('unprivileged: 1');
    transport.assertExecuted('pct config 112');
  });

  it('serves every fixture shape', () => {
    expect(readFixture('lxc-113-privileged-multi-nic.conf')).toContain('net1:');
    expect(readFixture('lxc-114-mp0.conf')).toContain('[PENDING]');
    expect(readFixture('vm-212-cloudinit-efi.conf')).toContain('efidisk0:');
    expect(JSON.parse(readFixture('pvesh-nodes.json'))).toHaveLength(1);
    expect(readFixture('etc-pve-storage.cfg')).toContain('lvmthin: local-lvm');
  });

  it('matches by regexp and predicate, newest rule first, and supports once', async () => {
    const transport = new FakeTransport()
      .onExec(/^qm /, { stdout: 'regexp' })
      .onExec((argv) => argv[0] === 'qm' && argv[1] === 'status', {
        stdout: 'predicate',
      });
    expect((await transport.exec(['qm', 'config', '1'])).stdout).toBe('regexp');
    expect((await transport.exec(['qm', 'status', '1'])).stdout).toBe(
      'predicate',
    );
  });

  it('consumes once rules and falls through afterwards', async () => {
    const transport = new FakeTransport()
      .onExec('x', { stdout: 'later' })
      .onExec(
        'x',
        { stdout: 'once', exitCode: 2, stderr: 'e', timedOut: true },
        { once: true },
      );
    const first = await transport.exec(['x']);
    expect(first).toEqual({
      exitCode: 2,
      stdout: 'once',
      stderr: 'e',
      timedOut: true,
    });
    expect((await transport.exec(['x'])).stdout).toBe('later');
  });

  it('streams output and passes stdin through call records', async () => {
    const transport = new FakeTransport().onExec('cat', {
      stdout: 'out',
      stderr: 'err',
    });
    const chunks: string[] = [];
    await transport.exec(['cat'], {
      stdin: 'script',
      onOutput: (stream, chunk) => chunks.push(`${stream}:${chunk}`),
    });
    expect(chunks).toEqual(['stdout:out', 'stderr:err']);
    expect(transport.calls[0]).toMatchObject({
      kind: 'exec',
      options: { stdin: 'script' },
    });
    await transport.exec(['cat']);
  });

  it('fails loudly for unscripted commands and unmet expectations', async () => {
    const transport = new FakeTransport();
    await expect(transport.exec(['rm', '-rf', '/'])).rejects.toThrow(
      'no scripted response',
    );
    expect(() => transport.assertExecuted('pct start 1')).toThrow(
      'not executed',
    );
  });

  it('honours cancellation', async () => {
    const transport = new FakeTransport().onExec('x', {});
    const controller = new AbortController();
    controller.abort();
    const { signal } = controller;
    await expect(transport.exec(['x'], { signal })).rejects.toBeInstanceOf(
      TransportAbortedError,
    );
    await expect(transport.readFile('/a', { signal })).rejects.toBeInstanceOf(
      TransportAbortedError,
    );
    await expect(
      transport.writeFile('/a', 'x', { signal }),
    ).rejects.toBeInstanceOf(TransportAbortedError);
  });

  it('reads and writes files', async () => {
    const transport = new FakeTransport().setFile(
      '/etc/pve/storage.cfg',
      'cfg',
    );
    expect(await transport.readFile('/etc/pve/storage.cfg')).toBe('cfg');
    await transport.writeFile('/tmp/x', 'data');
    expect(transport.getFile('/tmp/x')).toBe('data');
    expect(transport.getFile('/missing')).toBeUndefined();
    await expect(transport.readFile('/missing')).rejects.toBeInstanceOf(
      TransportFileNotFoundError,
    );
    expect(new TransportFileNotFoundError('/m').path).toBe('/m');
  });

  it('asserts the absence of mutations', async () => {
    const transport = new FakeTransport().onExec(/./, {});
    await transport.exec(['pct', 'config', '1']);
    expect(() => transport.assertNoMutations([/^pct config/])).not.toThrow();
    expect(() => transport.assertNoMutations()).toThrow('unexpected command');
    await transport.writeFile('/x', 'y');
    expect(() => transport.assertNoMutations([/./])).toThrow(
      'unexpected write',
    );
  });
});

describe('runMutation (dry-run contract)', () => {
  async function stop(context: ExecutorContext) {
    return runMutation(context, 'stop guest 112', (transport) =>
      transport.exec(['pct', 'stop', '112']),
    );
  }

  it('does not touch the transport in a dry run', async () => {
    const transport = new FakeTransport();
    const outcome = await stop({ transport, dryRun: true });
    expect(outcome).toEqual({
      status: 'skipped',
      description: 'stop guest 112',
    });
    transport.assertNoMutations();
    expect(transport.calls).toHaveLength(0);
  });

  it('applies the mutation otherwise', async () => {
    const transport = new FakeTransport().onExec('pct stop 112', {
      stdout: 'ok',
    });
    const outcome = await stop({ transport, dryRun: false });
    expect(outcome.status).toBe('applied');
    transport.assertExecuted('pct stop 112');
  });
});

describe('RecordingTransport', () => {
  it('captures sanitised output for fixtures without altering results', async () => {
    const inner = new FakeTransport()
      .onExec(/pct config/, {
        stdout: 'ip=198.51.100.7 secret=hunter2',
        stderr: 'hunter2',
      })
      .setFile('/f', 'content');
    const recorder = new RecordingTransport(inner, (text) =>
      text.replaceAll('hunter2', '***'),
    );
    const result = await recorder.exec(['pct', 'config', '1'], {
      stdin: 'hunter2',
    });
    await recorder.exec(['pct', 'config', '2']);
    expect(result.stdout).toContain('hunter2');
    expect(recorder.executions[0]).toMatchObject({
      stdin: '***',
      result: { stdout: 'ip=198.51.100.7 secret=***', stderr: '***' },
    });
    expect(recorder.executions[1]?.stdin).toBeUndefined();
    expect(await recorder.readFile('/f')).toBe('content');
    await recorder.writeFile('/g', 'x');
    expect(inner.getFile('/g')).toBe('x');
  });
});

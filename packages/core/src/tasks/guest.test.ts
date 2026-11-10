import { describe, expect, it } from 'vitest';
import { FakeTransport } from '../transport/fake.js';
import { TaskRunError } from './types.js';
import { createGuestTaskTransport, GuestTaskTransportError } from './guest.js';

describe('createGuestTaskTransport', () => {
  it('runs LXC task commands through pct exec with stdin', async () => {
    const host = new FakeTransport().onExec(
      (argv) => argv.join(' ') === 'pct exec 112 -- /bin/sh -s',
      { stdout: 'ok' },
    );
    const guest = createGuestTaskTransport(host, { type: 'lxc', vmid: 112 });
    const result = await guest.exec(['/bin/sh', '-s'], {
      stdin: 'echo hi\n',
    });
    expect(result).toEqual({
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      timedOut: false,
    });
    const call = host.calls[0];
    expect(call?.kind === 'exec' ? call.argv : []).toEqual([
      'pct',
      'exec',
      '112',
      '--',
      '/bin/sh',
      '-s',
    ]);
    expect(call?.kind === 'exec' ? call.options?.stdin : undefined).toBe(
      'echo hi\n',
    );
  });

  it('rejects file operations that do not belong to the task runner', async () => {
    const guest = createGuestTaskTransport(new FakeTransport(), {
      type: 'lxc',
      vmid: 112,
    });
    await expect(guest.readFile('/etc/hostname')).rejects.toThrow(TaskRunError);
    await expect(guest.writeFile('/tmp/x', 'x')).rejects.toThrow(TaskRunError);
  });

  it('runs VM task commands through the guest agent and decodes JSON', async () => {
    const chunks: string[] = [];
    const host = new FakeTransport().onExec(
      (argv) =>
        argv.join(' ') ===
        'qm guest exec 300 --synchronous 1 --timeout 0 --pass-stdin 1 -- /bin/sh -s',
      {
        stdout: JSON.stringify({
          exitcode: 3,
          'out-data': 'hello',
          'err-data': 'bad thing',
        }),
      },
    );
    const guest = createGuestTaskTransport(host, { type: 'vm', vmid: 300 });
    const result = await guest.exec(['/bin/sh', '-s'], {
      stdin: 'echo hello\n',
      onOutput: (stream, chunk) => chunks.push(`${stream}:${chunk}`),
    });
    expect(result).toEqual({
      exitCode: 3,
      stdout: 'hello',
      stderr: 'bad thing',
      timedOut: false,
    });
    expect(chunks).toEqual(['stdout:hello', 'stderr:bad thing']);
    const call = host.calls[0];
    expect(call?.kind === 'exec' ? call.options?.stdin : undefined).toBe(
      'echo hello\n',
    );
    expect(call?.kind === 'exec' ? call.options?.onOutput : 'missing').toBe(
      undefined,
    );
  });

  it('omits pass-stdin when there is no payload and defaults missing fields', async () => {
    const host = new FakeTransport().onExec(
      (argv) =>
        argv.join(' ') ===
        'qm guest exec 300 --synchronous 1 --timeout 0 -- /bin/true',
      { stdout: '{}' },
    );
    const guest = createGuestTaskTransport(host, { type: 'vm', vmid: 300 });
    const chunks: string[] = [];
    const result = await guest.exec(['/bin/true'], {
      onOutput: (stream, chunk) => chunks.push(`${stream}:${chunk}`),
    });
    expect(result).toEqual({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
    });
    expect(chunks).toEqual([]);
    const call = host.calls[0];
    expect(call?.kind === 'exec' ? call.argv : []).not.toContain(
      '--pass-stdin',
    );
  });

  it('preserves host timeouts and host-level failures', async () => {
    const timedOutHost = new FakeTransport().onExec(
      (argv) => argv[0] === 'qm',
      { timedOut: true, exitCode: 124 },
    );
    const timedOut = await createGuestTaskTransport(timedOutHost, {
      type: 'vm',
      vmid: 300,
    }).exec(['/bin/true'], {});
    expect(timedOut).toEqual({
      exitCode: 124,
      stdout: '',
      stderr: '',
      timedOut: true,
    });

    const failedHost = new FakeTransport().onExec((argv) => argv[0] === 'qm', {
      exitCode: 1,
      stderr: 'agent unavailable',
    });
    await expect(
      createGuestTaskTransport(failedHost, { type: 'vm', vmid: 300 }).exec(
        ['/bin/true'],
        {},
      ),
    ).resolves.toEqual({
      exitCode: 1,
      stdout: '',
      stderr: 'agent unavailable',
      timedOut: false,
    });
  });

  it('rejects malformed guest agent responses', async () => {
    const notJson = new FakeTransport().onExec((argv) => argv[0] === 'qm', {
      stdout: 'not json',
    });
    await expect(
      createGuestTaskTransport(notJson, { type: 'vm', vmid: 300 }).exec(
        ['/bin/true'],
        {},
      ),
    ).rejects.toThrow(/was not JSON/);

    const notObject = new FakeTransport().onExec((argv) => argv[0] === 'qm', {
      stdout: 'null',
    });
    await expect(
      createGuestTaskTransport(notObject, { type: 'vm', vmid: 300 }).exec(
        ['/bin/true'],
        {},
      ),
    ).rejects.toThrow(/was not an object/);
  });

  it('validates the guest target', () => {
    const host = new FakeTransport();
    expect(() =>
      createGuestTaskTransport(host, {
        type: 'docker' as 'lxc',
        vmid: 300,
      }),
    ).toThrow(GuestTaskTransportError);
    expect(() =>
      createGuestTaskTransport(host, { type: 'lxc', vmid: 0 }),
    ).toThrow(/positive integer/);
    expect(() =>
      createGuestTaskTransport(host, { type: 'vm', vmid: 1.5 }),
    ).toThrow(/positive integer/);
  });
});

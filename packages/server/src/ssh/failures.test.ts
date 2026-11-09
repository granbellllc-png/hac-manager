import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FixtureSshClient } from '../../fixtures/ssh-client.js';
import { SshConnection } from './connection.js';
import { HostKeyMismatchError } from './types.js';

vi.mock('ssh2', async () => ({
  Client: (await import('../../fixtures/ssh-client.js')).FixtureSshClient,
}));
const connections: SshConnection[] = [];
function connection(fingerprint?: string) {
  const value = new SshConnection('fixture', {
    host: 'fixture.invalid',
    fingerprint,
  });
  connections.push(value);
  return value;
}
beforeEach(() => FixtureSshClient.reset());
afterEach(async () => {
  for (const value of connections.splice(0)) await value.disconnect();
  vi.useRealTimers();
});

describe('SSH handshake, channel and SFTP failures', () => {
  it.each(['error', 'close', 'throw', 'throw-string'] as const)(
    'rejects a failed handshake: %s',
    async (mode) => {
      FixtureSshClient.connectMode = mode;
      await expect(connection().connect()).rejects.toThrow();
    },
  );

  it('reports a mismatched pin even when the peer closes during negotiation', async () => {
    FixtureSshClient.connectMode = 'close';
    await expect(connection('SHA256:wrong').connect()).rejects.toBeInstanceOf(
      HostKeyMismatchError,
    );
  });

  it('retrusts a captured key and reuses a connected session', async () => {
    const value = connection('SHA256:wrong');
    await expect(value.connect()).rejects.toBeInstanceOf(HostKeyMismatchError);
    value.retrustHostKey();
    await value.connect();
    await value.connect();
    expect(FixtureSshClient.instances).toHaveLength(2);
    expect(value.state).toBe('connected');
  });

  it('streams stdout/stderr, accepts stdin, and handles absent exit status', async () => {
    FixtureSshClient.execMode = 'no-exit-code';
    const value = connection();
    const onOutput = vi.fn();
    expect(
      await value.exec(['cat'], {
        stdin: 'fixture-input',
        onOutput,
        signal: new AbortController().signal,
      }),
    ).toMatchObject({
      exitCode: 0,
      stdout: 'fixture-input',
      stderr: 'fixture-stderr',
    });
    expect(onOutput.mock.calls).toEqual([
      ['stdout', 'fixture-input'],
      ['stderr', 'fixture-stderr'],
    ]);
  });

  it('releases a rejected channel and permits a subsequent command', async () => {
    FixtureSshClient.execMode = 'reject';
    const value = connection();
    await expect(value.exec(['fixture'])).rejects.toThrow('channel rejected');
    FixtureSshClient.execMode = 'success';
    expect((await value.exec(['fixture'])).exitCode).toBe(0);
  });

  it('cancels an active command and does not resolve it from a late close', async () => {
    FixtureSshClient.execMode = 'hang';
    const value = connection();
    await value.connect();
    const abort = new AbortController();
    const result = value.exec(['fixture'], { signal: abort.signal });
    const assertion = expect(result).rejects.toThrow('abort');
    await vi.waitFor(() =>
      expect(FixtureSshClient.instances[0]?.channels.length).toBe(1),
    );
    abort.abort();
    await assertion;
    FixtureSshClient.instances[0]?.channels[0]?.emit('close', 0);
  });

  it('rejects active commands when the client fails and reconnects with backoff', async () => {
    vi.useFakeTimers();
    FixtureSshClient.execMode = 'hang';
    const value = connection();
    await value.connect();
    const result = value.exec(['fixture']);
    const assertion = expect(result).rejects.toThrow('fixture disconnect');
    await Promise.resolve();
    const client = FixtureSshClient.instances[0]!;
    client.emit('error', new Error('fixture disconnect'));
    client.emit('close');
    await assertion;
    await vi.advanceTimersByTimeAsync(500);
    expect(value.state).toBe('connected');
    expect(FixtureSshClient.instances).toHaveLength(2);
  });

  it('clears scheduled reconnects on an explicit connection or disconnect', async () => {
    vi.useFakeTimers();
    const value = connection();
    await value.connect();
    FixtureSshClient.instances[0]!.emit('close');
    await value.connect();
    expect(value.state).toBe('connected');
    FixtureSshClient.instances[1]!.emit('close');
    await value.disconnect();
    await vi.advanceTimersByTimeAsync(1000);
    expect(FixtureSshClient.instances).toHaveLength(2);
  });

  it('handles a failed background reconnect without an unhandled rejection', async () => {
    vi.useFakeTimers();
    const value = connection();
    await value.connect();
    FixtureSshClient.instances[0]!.emit('close');
    FixtureSshClient.connectMode = 'error';
    await vi.advanceTimersByTimeAsync(500);
    expect(value.state).toBe('error');
  });

  it('rejects SFTP initialization and pre-aborted operations', async () => {
    const value = connection();
    await expect(
      value.readFile('/fixture', { signal: AbortSignal.abort() }),
    ).rejects.toThrow('abort');
    await expect(
      value.writeFile('/fixture', 'text', { signal: AbortSignal.abort() }),
    ).rejects.toThrow('abort');
    FixtureSshClient.sftpMode = 'reject';
    await expect(value.readFile('/fixture')).rejects.toThrow('SFTP rejected');
  });

  it('writes and reads files with signals and cleans up successful streams', async () => {
    const value = connection();
    const signal = new AbortController().signal;
    await value.writeFile('/fixture', 'fixture-content', { signal });
    expect(await value.readFile('/fixture', { signal })).toBe(
      'fixture-content',
    );
  });

  it.each(['read', 'write'] as const)(
    'propagates an active %s stream error',
    async (operation) => {
      FixtureSshClient.files.set('/fixture', 'content');
      FixtureSshClient.readMode = 'error';
      FixtureSshClient.writeMode = 'error';
      const value = connection();
      const signal = new AbortController().signal;
      await expect(
        operation === 'read'
          ? value.readFile('/fixture', { signal })
          : value.writeFile('/fixture', 'content', { signal }),
      ).rejects.toThrow(`fixture ${operation} failed`);
    },
  );

  it.each(['read', 'write'] as const)(
    'aborts an active %s transfer and destroys its stream',
    async (operation) => {
      FixtureSshClient.files.set('/fixture', 'content');
      FixtureSshClient.readMode = 'hang';
      FixtureSshClient.writeMode = 'hang';
      const value = connection();
      const abort = new AbortController();
      const result =
        operation === 'read'
          ? value.readFile('/fixture', { signal: abort.signal })
          : value.writeFile('/fixture', 'content', { signal: abort.signal });
      const assertion = expect(result).rejects.toThrow('abort');
      await vi.waitFor(() =>
        expect(FixtureSshClient.instances[0]?.streams.length).toBe(1),
      );
      abort.abort();
      await assertion;
      expect(FixtureSshClient.instances[0]?.streams[0]?.destroyed).toBe(true);
    },
  );
});

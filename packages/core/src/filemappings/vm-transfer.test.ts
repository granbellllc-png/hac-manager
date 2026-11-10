import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { StepExecutionContext, StepLogger } from '../steps/types.js';
import { FakeTransport } from '../transport/fake.js';
import {
  createVmArchiveTransferStep,
  createVmDirectoryTransferStep,
  createVmFileTransferStep,
  pullVmFile,
  resolveVmTransferStrategy,
  transferVmArchive,
  transferVmDirectory,
  transferVmFile,
  VM_AGENT_CHUNK_BYTES,
  VmFileTransferError,
  VmTransferUnavailableError,
} from './vm-transfer.js';

function logger(): StepLogger {
  return { info() {}, warn() {}, error() {} };
}

function context(transport: FakeTransport): StepExecutionContext<undefined> {
  return {
    operationId: 'op-vm',
    input: undefined,
    transport,
    logger: logger(),
    dryRun: false,
    signal: new AbortController().signal,
  };
}

function agentJson(
  result: {
    readonly exitcode?: number;
    readonly out?: string;
    readonly err?: string;
  } = {},
): string {
  return JSON.stringify({
    exitcode: result.exitcode ?? 0,
    exited: 1,
    ...(result.out !== undefined ? { 'out-data': result.out } : {}),
    ...(result.err !== undefined ? { 'err-data': result.err } : {}),
  });
}

function agentResponse(result: Parameters<typeof agentJson>[0] = {}): {
  stdout: string;
} {
  return { stdout: agentJson(result) };
}

function agentHost(): FakeTransport {
  return new FakeTransport()
    .onExec(/^qm agent 212 ping$/, {})
    .onExec(
      /^qm guest exec 212 --synchronous 1 --timeout 0 --pass-stdin 1 -- sh -s -- /,
      agentResponse(),
    )
    .onExec(
      /^qm guest exec 212 --synchronous 1 --timeout 0 -- test -f /,
      agentResponse(),
    )
    .onExec(
      /^qm guest exec 212 --synchronous 1 --timeout 0 -- test -d /,
      agentResponse(),
    );
}

function stdinOf(
  transport: FakeTransport,
  pattern: RegExp,
): string | undefined {
  for (const call of transport.calls) {
    if (
      call.kind === 'exec' &&
      pattern.test(call.argv.join(' ')) &&
      call.options?.stdin !== undefined
    ) {
      return call.options.stdin;
    }
  }
  return undefined;
}

function readOctal(block: Buffer, offset: number, length: number): number {
  return Number.parseInt(
    block
      .subarray(offset, offset + length)
      .toString('ascii')
      .replace(/\0.*$/, '')
      .trim(),
    8,
  );
}

function tarHeaders(archive: Uint8Array): Buffer[] {
  const buffer = Buffer.from(archive);
  const headers: Buffer[] = [];
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const block = buffer.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;
    headers.push(Buffer.from(block));
    offset += 512 + Math.ceil(readOctal(block, 124, 12) / 512) * 512;
  }
  return headers;
}

describe('VM transfer strategy', () => {
  it('prefers SSH and falls back to an answering guest agent', async () => {
    await expect(
      resolveVmTransferStrategy({
        host: new FakeTransport(),
        guest: new FakeTransport(),
        vmid: 212,
      }),
    ).resolves.toBe('ssh');
    await expect(
      resolveVmTransferStrategy({
        host: new FakeTransport(),
        guest: new FakeTransport(),
        vmid: 212,
        strategy: 'ssh',
      }),
    ).resolves.toBe('ssh');
    await expect(
      resolveVmTransferStrategy({ host: agentHost(), vmid: 212 }),
    ).resolves.toBe('agent');
    await expect(
      resolveVmTransferStrategy({
        host: new FakeTransport(),
        vmid: 212,
        strategy: 'agent',
      }),
    ).resolves.toBe('agent');
  });

  it('reports a clear error when neither transport is available', async () => {
    const host = new FakeTransport().onExec(/^qm agent 212 ping$/, {
      exitCode: 1,
      stderr: 'QEMU guest agent is not running',
    });
    await expect(
      resolveVmTransferStrategy({ host, vmid: 212 }),
    ).rejects.toBeInstanceOf(VmTransferUnavailableError);
    await expect(
      resolveVmTransferStrategy({ host, vmid: 212, strategy: 'ssh' }),
    ).rejects.toBeInstanceOf(VmTransferUnavailableError);

    const silent = new FakeTransport().onExec(/^qm agent 212 ping$/, {
      exitCode: 1,
    });
    await expect(
      resolveVmTransferStrategy({ host: silent, vmid: 212 }),
    ).rejects.toThrow('qm agent ping exited with 1');
  });
});

describe('guest-agent file transfer', () => {
  it('uploads a single file in chunks and installs mode and ownership', async () => {
    const host = agentHost();
    await transferVmFile(
      { host, vmid: 212, token: 'agent' },
      {
        destination: '/etc/app.conf',
        content: 'listen=127.0.0.1\n',
        mode: '0640',
        owner: 1000,
        group: 1001,
      },
    );

    expect(host.execArgv[0]).toEqual(['qm', 'agent', '212', 'ping']);
    const install = host.execArgv.find((argv) =>
      argv
        .join(' ')
        .startsWith(
          'qm guest exec 212 --synchronous 1 --timeout 0 --pass-stdin 1 -- sh -s -- /var/tmp/hacm-agent.upload /etc/app.conf 0640',
        ),
    );
    expect(install?.slice(-5)).toEqual([
      '/var/tmp/hacm-agent.upload',
      '/etc/app.conf',
      '0640',
      '1000',
      '1001',
    ]);
    const append = host.calls
      .filter(
        (call) =>
          call.kind === 'exec' &&
          call.argv.join(' ').endsWith('/var/tmp/hacm-agent.upload'),
      )
      .map((call) => (call.kind === 'exec' ? call.options?.stdin : undefined))
      .find((script) => script?.includes('base64 -d'));
    expect(append).toContain(
      Buffer.from('listen=127.0.0.1\n').toString('base64'),
    );
    const installScript = stdinOf(host, /\/etc\/app\.conf 0640 1000 1001$/);
    expect(installScript).toContain('install -m "$mode"');
    expect(installScript).toContain('chown -- "$owner:$group"');
  });

  it('generates a staging token when none is configured', async () => {
    const host = agentHost();
    await transferVmFile(
      { host, vmid: 212 },
      { destination: '/etc/default.conf', content: 'x', mode: '0644' },
    );
    const upload = host.execArgv.find((argv) =>
      argv.some((arg) => /^\/var\/tmp\/hacm-[a-f0-9]{16}\.upload$/.test(arg)),
    );
    expect(upload).toBeDefined();
  });

  it('chunks payloads above the agent stdin limit over several calls', async () => {
    const host = agentHost();
    const content = new Uint8Array(VM_AGENT_CHUNK_BYTES + 10).fill(65);
    await transferVmFile(
      { host, vmid: 212, token: 'chunked', strategy: 'agent' },
      { destination: '/opt/big.bin', content },
    );
    const appendCalls = host.execArgv.filter((argv) =>
      argv.includes('/var/tmp/hacm-chunked.upload'),
    );
    // Truncate, two chunks and the final install all target the staging file.
    expect(appendCalls).toHaveLength(4);
    const chunks = host.calls
      .filter(
        (call) =>
          call.kind === 'exec' &&
          call.argv.join(' ').endsWith('/var/tmp/hacm-chunked.upload') &&
          call.options?.stdin?.includes('base64 -d') === true,
      )
      .map((call) => (call.kind === 'exec' ? call.options?.stdin : undefined));
    expect(chunks).toHaveLength(2);
  });

  it('syncs a directory as one tar stream and applies deletes once', async () => {
    const host = agentHost();
    const files = Array.from({ length: 100 }, (_, index) => ({
      path: `nested/file-${index}.conf`,
      content: `value=${index}`,
      mode: '0644',
    }));
    await transferVmDirectory(
      { host, vmid: 212, token: 'dir' },
      {
        destination: '/srv/app',
        files,
        deletePaths: ['/srv/app/stale-a.conf', '/srv/app/stale-b.conf'],
      },
    );

    const stagingCalls = host.execArgv.filter((argv) =>
      argv.includes('/var/tmp/hacm-dir.tar.gz'),
    );
    // Truncate, one or more chunks, then exactly one extract command.
    expect(stagingCalls).toHaveLength(3);
    const extract = stagingCalls.at(-1)!;
    expect(extract.slice(-4)).toEqual([
      '/var/tmp/hacm-dir.tar.gz',
      '/srv/app',
      '/srv/app/stale-a.conf',
      '/srv/app/stale-b.conf',
    ]);
    const archiveScript = stdinOf(host, /hacm-dir\.tar\.gz \/srv\/app/);
    expect(archiveScript).toContain('tar -xpzf');
    expect(archiveScript).toContain('rm -f -- "$@"');

    const chunks = host.calls.filter(
      (call) =>
        call.kind === 'exec' &&
        call.argv.join(' ').endsWith('/var/tmp/hacm-dir.tar.gz') &&
        call.options?.stdin?.includes('base64 -d') === true,
    );
    const encoded = /printf '%s' '([^']+)'/.exec(
      (chunks[0] as { options?: { stdin?: string } }).options?.stdin ?? '',
    )?.[1];
    expect(encoded).toBeDefined();
    const archive = gunzipSync(Buffer.from(encoded!, 'base64'));
    expect(tarHeaders(archive)).toHaveLength(100);
  });

  it('extracts archives and deletes paths when a directory sync has no files', async () => {
    const host = agentHost().onExec(
      /^qm guest exec 212 --synchronous 1 --timeout 0 --pass-stdin 1 -- sh -s -- rm$/,
      agentResponse(),
    );
    await transferVmArchive(
      { host, vmid: 212, token: 'archive' },
      {
        destination: '/opt/app',
        archive: Uint8Array.from([1, 2, 3]),
        format: 'zip',
      },
    );
    expect(stdinOf(host, /hacm-archive\.zip \/opt\/app zip$/)).toContain(
      'unzip -oq',
    );

    const deletions = new FakeTransport().onExec(
      /^qm guest exec 212 --synchronous 1 --timeout 0 --pass-stdin 1 -- sh -s -- \/srv\/app\/stale$/,
      agentResponse(),
    );
    await transferVmDirectory(
      { host: deletions, vmid: 212, strategy: 'agent', token: 'empty' },
      {
        destination: '/srv/app',
        files: [],
        deletePaths: ['/srv/app/stale'],
      },
    );
    expect(deletions.execArgv).toHaveLength(1);
    expect(stdinOf(deletions, /stale$/)).toContain('rm -f -- "$@"');
  });

  it('does nothing for an empty directory without deletes and keeps tar ownership', async () => {
    const empty = new FakeTransport();
    await transferVmDirectory(
      { host: empty, vmid: 212, strategy: 'agent', token: 'noop' },
      { destination: '/srv/app', files: [] },
    );
    expect(empty.calls).toHaveLength(0);

    const host = agentHost();
    await transferVmDirectory(
      { host, vmid: 212, token: 'owned' },
      {
        destination: '/srv/app',
        files: [
          {
            path: 'owned.conf',
            content: 'owned',
            mode: '0640',
            owner: 1000,
            group: 1001,
            mtime: new Date('2026-11-10T12:00:00.000Z'),
          },
        ],
      },
    );
    const append = host.calls.find(
      (call) =>
        call.kind === 'exec' &&
        call.argv.includes('/var/tmp/hacm-owned.tar.gz') &&
        call.options?.stdin?.includes('base64 -d') === true,
    );
    expect(append?.kind).toBe('exec');
    if (append?.kind !== 'exec') throw new Error('missing append');
    const encoded = /printf '%s' '([^']+)'/.exec(
      append.options?.stdin ?? '',
    )?.[1];
    const headers = tarHeaders(gunzipSync(Buffer.from(encoded!, 'base64')));
    expect(readOctal(headers[0]!, 108, 8)).toBe(1000);
    expect(readOctal(headers[0]!, 116, 8)).toBe(1001);
  });

  it('pulls a file in agent chunks', async () => {
    const host = new FakeTransport()
      .onExec(
        /^qm guest exec 212 --synchronous 1 --timeout 0 --pass-stdin 1 -- sh -s -- \/opt\/app$/,
        agentResponse({ out: '4\n' }),
      )
      .onExec(
        /^qm guest exec 212 --synchronous 1 --timeout 0 --pass-stdin 1 -- sh -s -- \/opt\/app 0$/,
        agentResponse({ out: Buffer.from([9, 8, 7, 6]).toString('base64') }),
      );
    const bytes = await pullVmFile(
      { host, vmid: 212, strategy: 'agent' },
      { path: '/opt/app' },
    );
    expect([...bytes]).toEqual([9, 8, 7, 6]);

    const empty = new FakeTransport().onExec(
      /^qm guest exec 212 --synchronous 1 --timeout 0 --pass-stdin 1 -- sh -s -- \/opt\/empty$/,
      agentResponse({ out: '0' }),
    );
    await expect(
      pullVmFile(
        { host: empty, vmid: 212, strategy: 'agent' },
        { path: '/opt/empty' },
      ),
    ).resolves.toHaveLength(0);

    const broken = new FakeTransport().onExec(
      /^qm guest exec 212 --synchronous 1 --timeout 0 --pass-stdin 1 -- sh -s -- \/opt\/broken$/,
      agentResponse({ out: 'nope' }),
    );
    await expect(
      pullVmFile(
        { host: broken, vmid: 212, strategy: 'agent' },
        { path: '/opt/broken' },
      ),
    ).rejects.toBeInstanceOf(VmFileTransferError);
  });
});

describe('SSH/SFTP file transfer', () => {
  function sshGuest(): FakeTransport {
    return new FakeTransport()
      .onExec(/^sh -s -- /, {})
      .onExec(/^test -f /, {})
      .onExec(/^test -d /, {});
  }

  it('uploads a file through SFTP and decodes it inside the guest', async () => {
    const guest = sshGuest();
    const host = new FakeTransport();
    await transferVmFile(
      { host, guest, vmid: 212, token: 'ssh' },
      {
        destination: '/etc/app.conf',
        content: 'hello',
        mode: '0600',
        owner: 1000,
        group: 1000,
      },
    );

    expect(host.calls).toHaveLength(0);
    const encoded = guest.getFile('/var/tmp/hacm-ssh.b64');
    expect(Buffer.from(encoded!, 'base64').toString()).toBe('hello');
    expect(guest.execArgv[0]?.slice(0, 5)).toEqual([
      'sh',
      '-s',
      '--',
      '/var/tmp/hacm-ssh.b64',
      '/etc/app.conf',
    ]);
    expect(stdinOf(guest, /hacm-ssh\.b64/)).toContain('base64 -d');
  });

  it('streams a directory and archive over SFTP without per-file commands', async () => {
    const guest = sshGuest();
    const host = new FakeTransport();
    const files = Array.from({ length: 50 }, (_, index) => ({
      path: `file-${index}.conf`,
      content: `value=${index}`,
    }));
    await transferVmDirectory(
      { host, guest, vmid: 212, token: 'ssh-dir' },
      {
        destination: '/srv/app',
        files,
        deletePaths: ['/srv/app/stale.conf'],
      },
    );
    expect(guest.execArgv).toHaveLength(1);
    const archive = gunzipSync(
      Buffer.from(guest.getFile('/var/tmp/hacm-ssh-dir.tar.gz.b64')!, 'base64'),
    );
    expect(tarHeaders(archive)).toHaveLength(50);
    expect(stdinOf(guest, /hacm-ssh-dir\.tar\.gz\.b64/)).toContain('tar -xpzf');

    await transferVmArchive(
      { host, guest, vmid: 212, token: 'ssh-archive' },
      {
        destination: '/opt/app',
        archive: 'fake',
        format: 'tar.xz',
      },
    );
    expect(stdinOf(guest, /hacm-ssh-archive\.tar\.xz\.b64/)).toContain(
      'tar -xpJf',
    );

    await transferVmDirectory(
      { host, guest, vmid: 212, token: 'ssh-empty' },
      {
        destination: '/srv/app',
        files: [],
        deletePaths: ['/srv/app/stale.conf'],
      },
    );
    expect(stdinOf(guest, /\/srv\/app\/stale\.conf$/)).toContain(
      'rm -f -- "$@"',
    );
  });

  it('reports SSH command failures with and without stderr', async () => {
    const failing = new FakeTransport().onExec(/^sh -s -- /, {
      exitCode: 1,
      stderr: 'no space left',
    });
    await expect(
      transferVmFile(
        {
          host: new FakeTransport(),
          guest: failing,
          vmid: 212,
          token: 'ssh-fail',
        },
        { destination: '/etc/app.conf', content: 'x' },
      ),
    ).rejects.toThrow('no space left');

    const silent = new FakeTransport()
      .onExec(/^sh -s -- /, { exitCode: 1 })
      .onExec(/^rm -f -- /, {});
    await expect(
      transferVmArchive(
        {
          host: new FakeTransport(),
          guest: silent,
          vmid: 212,
          token: 'ssh-silent',
        },
        { destination: '/opt/app', archive: 'x', format: 'zip' },
      ),
    ).rejects.toThrow('exit code 1');
  });

  it('pulls a binary file over SSH', async () => {
    const guest = new FakeTransport().onExec(/^sh -s -- /, {
      stdout: Buffer.from([0, 1, 255]).toString('base64'),
    });
    const bytes = await pullVmFile(
      { host: new FakeTransport(), guest, vmid: 212 },
      { path: '/opt/app.tar.gz' },
    );
    expect([...bytes]).toEqual([0, 1, 255]);
  });
});

describe('VM transfer validation and steps', () => {
  it('rejects unsafe paths, modes, ids and tokens', async () => {
    const runtime = {
      host: agentHost(),
      vmid: 212,
      strategy: 'agent' as const,
    };
    await expect(
      transferVmFile(runtime, { destination: '/', content: 'x' }),
    ).rejects.toBeInstanceOf(VmFileTransferError);
    await expect(
      transferVmFile(runtime, { destination: 'relative', content: 'x' }),
    ).rejects.toBeInstanceOf(VmFileTransferError);
    await expect(
      transferVmFile(runtime, {
        destination: '/etc/app.conf',
        content: 'x',
        mode: 'nope',
      }),
    ).rejects.toBeInstanceOf(VmFileTransferError);
    await expect(
      transferVmFile(runtime, {
        destination: '/etc/app.conf',
        content: 'x',
        owner: -1,
      }),
    ).rejects.toBeInstanceOf(VmFileTransferError);
    await expect(
      transferVmFile(runtime, {
        destination: '/etc/app.conf',
        content: 'x',
        token: 'bad token',
      }),
    ).rejects.toBeInstanceOf(VmFileTransferError);
    await expect(
      transferVmDirectory(runtime, {
        destination: '/srv/app',
        files: [{ path: '../escape', content: 'x' }],
      }),
    ).rejects.toBeInstanceOf(VmFileTransferError);
    await expect(
      transferVmDirectory(runtime, {
        destination: '/srv/app',
        files: [{ path: 'safe', content: 'x', group: -1 }],
      }),
    ).rejects.toBeInstanceOf(VmFileTransferError);
    await expect(
      transferVmDirectory(runtime, {
        destination: '/srv/app',
        files: [{ path: 'safe', content: 'x' }],
        deletePaths: ['/srv/../escape'],
      }),
    ).rejects.toBeInstanceOf(VmFileTransferError);
    await expect(
      resolveVmTransferStrategy({ host: new FakeTransport(), vmid: 0 }),
    ).rejects.toBeInstanceOf(VmFileTransferError);
  });

  it('reports malformed agent responses and command failures', async () => {
    const malformed = new FakeTransport().onExec(
      /^qm guest exec 212 --synchronous 1 --timeout 0 --pass-stdin 1 -- sh -s -- /,
      { stdout: 'not json' },
    );
    await expect(
      transferVmFile(
        { host: malformed, vmid: 212, strategy: 'agent' },
        { destination: '/etc/app.conf', content: 'x', token: 'bad-json' },
      ),
    ).rejects.toBeInstanceOf(VmFileTransferError);

    const failing = new FakeTransport()
      .onExec(
        /^qm guest exec 212 --synchronous 1 --timeout 0 --pass-stdin 1 -- sh -s -- /,
        agentResponse({ exitcode: 7, err: 'permission denied' }),
      )
      .onExec(/^rm -f -- /, {});
    await expect(
      transferVmFile(
        { host: failing, vmid: 212, strategy: 'agent' },
        { destination: '/etc/app.conf', content: 'x', token: 'fail' },
      ),
    ).rejects.toThrow('permission denied');

    const notObject = new FakeTransport().onExec(
      /^qm guest exec 212 --synchronous 1 --timeout 0 --pass-stdin 1 -- sh -s -- /,
      { stdout: '42' },
    );
    await expect(
      transferVmFile(
        { host: notObject, vmid: 212, strategy: 'agent' },
        { destination: '/etc/app.conf', content: 'x', token: 'number' },
      ),
    ).rejects.toBeInstanceOf(VmFileTransferError);

    const noExitCode = new FakeTransport().onExec(
      /^qm guest exec 212 --synchronous 1 --timeout 0 --pass-stdin 1 -- sh -s -- /,
      { stdout: JSON.stringify({ exited: 1 }) },
    );
    await transferVmFile(
      { host: noExitCode, vmid: 212, strategy: 'agent' },
      { destination: '/etc/app.conf', content: 'x', token: 'no-exit' },
    );

    const outputOnly = new FakeTransport().onExec(
      /^qm guest exec 212 --synchronous 1 --timeout 0 --pass-stdin 1 -- sh -s -- /,
      agentResponse({ exitcode: 7, out: 'guest said no' }),
    );
    await expect(
      transferVmFile(
        { host: outputOnly, vmid: 212, strategy: 'agent' },
        { destination: '/etc/app.conf', content: 'x', token: 'out-only' },
      ),
    ).rejects.toThrow('guest said no');

    const bareExit = new FakeTransport().onExec(
      /^qm guest exec 212 --synchronous 1 --timeout 0 --pass-stdin 1 -- sh -s -- /,
      agentResponse({ exitcode: 7 }),
    );
    await expect(
      transferVmFile(
        { host: bareExit, vmid: 212, strategy: 'agent' },
        { destination: '/etc/app.conf', content: 'x', token: 'bare-exit' },
      ),
    ).rejects.toThrow('exit code 7');

    const transportFailure = new FakeTransport().onExec(
      /^qm guest exec 212 --synchronous 1 --timeout 0 --pass-stdin 1 -- sh -s -- /,
      { exitCode: 3 },
    );
    await expect(
      transferVmFile(
        { host: transportFailure, vmid: 212, strategy: 'agent' },
        { destination: '/etc/app.conf', content: 'x', token: 'transport' },
      ),
    ).rejects.toThrow('exit code 3');
  });

  it('applies and verifies journaled file and directory steps', async () => {
    const transport = agentHost();
    const fileStep = createVmFileTransferStep({
      vmid: 212,
      token: 'step-file',
      destination: '/etc/app.conf',
      content: 'x',
      timeoutMs: 5_000,
    });
    expect(await fileStep.check(context(transport))).toEqual({
      status: 'required',
    });
    await expect(fileStep.apply(context(transport))).resolves.toMatchObject({
      destination: '/etc/app.conf',
    });
    await expect(fileStep.verify(context(transport))).resolves.toMatchObject({
      transferred: true,
    });

    const directoryStep = createVmDirectoryTransferStep({
      vmid: 212,
      token: 'step-dir',
      destination: '/srv/app',
      files: [{ path: 'a.conf', content: 'a' }],
    });
    await expect(
      directoryStep.apply(context(transport)),
    ).resolves.toMatchObject({ files: 1, deleted: 0 });
    await expect(
      directoryStep.verify(context(transport)),
    ).resolves.toMatchObject({ synced: true });

    const archiveStep = createVmArchiveTransferStep({
      vmid: 212,
      token: 'step-archive',
      destination: '/opt/app',
      archive: 'archive',
      format: 'tar.gz',
    });
    expect(await archiveStep.check(context(transport))).toEqual({
      status: 'required',
    });
    await expect(archiveStep.apply(context(transport))).resolves.toMatchObject({
      format: 'tar.gz',
    });
    await expect(archiveStep.verify(context(transport))).resolves.toMatchObject(
      {
        extracted: true,
      },
    );
  });

  it('skips empty directory steps and fails verification when paths vanish', async () => {
    const empty = createVmDirectoryTransferStep({
      vmid: 212,
      destination: '/srv/app',
      files: [],
    });
    expect(await empty.check(context(new FakeTransport()))).toEqual({
      status: 'satisfied',
    });
    const deletionOnly = createVmDirectoryTransferStep({
      vmid: 212,
      destination: '/srv/app',
      files: [],
      deletePaths: ['/srv/app/stale'],
    });
    expect(await deletionOnly.check(context(new FakeTransport()))).toEqual({
      status: 'required',
    });

    const transport = new FakeTransport()
      .onExec(
        /^qm guest exec 212 --synchronous 1 --timeout 0 --pass-stdin 1 -- sh -s -- /,
        agentResponse(),
      )
      .onExec(
        /^qm guest exec 212 --synchronous 1 --timeout 0 -- test -f /,
        agentResponse({ exitcode: 1 }),
      )
      .onExec(
        /^qm guest exec 212 --synchronous 1 --timeout 0 -- test -d /,
        agentResponse({ exitcode: 1 }),
      );
    const fileStep = createVmFileTransferStep({
      vmid: 212,
      strategy: 'agent',
      token: 'missing-file',
      destination: '/etc/missing.conf',
      content: 'x',
    });
    await fileStep.apply(context(transport));
    await expect(fileStep.verify(context(transport))).rejects.toBeInstanceOf(
      VmFileTransferError,
    );

    const directoryStep = createVmDirectoryTransferStep({
      vmid: 212,
      strategy: 'agent',
      token: 'missing-dir',
      destination: '/srv/missing',
      files: [{ path: 'a', content: 'a' }],
    });
    await directoryStep.apply(context(transport));
    await expect(
      directoryStep.verify(context(transport)),
    ).rejects.toBeInstanceOf(VmFileTransferError);

    const archiveStep = createVmArchiveTransferStep({
      vmid: 212,
      strategy: 'agent',
      token: 'missing-archive',
      destination: '/opt/missing',
      archive: 'archive',
      format: 'zip',
    });
    await archiveStep.apply(context(transport));
    await expect(archiveStep.verify(context(transport))).rejects.toBeInstanceOf(
      VmFileTransferError,
    );
  });

  it('checks directory existence over SSH', async () => {
    const guest = new FakeTransport()
      .onExec(/^test -d \/srv\/app$/, {})
      .onExec(/^sh -s -- /, {});
    const step = createVmDirectoryTransferStep({
      vmid: 212,
      guest,
      token: 'ssh-step',
      destination: '/srv/app',
      files: [{ path: 'a', content: 'a' }],
    });
    await step.apply(context(new FakeTransport()));
    await expect(
      step.verify(context(new FakeTransport())),
    ).resolves.toMatchObject({ synced: true });
  });
});

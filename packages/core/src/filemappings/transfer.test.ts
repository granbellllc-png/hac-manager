import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { FakeTransport } from '../transport/fake.js';
import type { StepExecutionContext, StepLogger } from '../steps/types.js';
import {
  buildTarArchive,
  buildTarGz,
  TarArchiveError,
  type TarEntry,
} from './tar.js';
import {
  createLxcArchiveTransferStep,
  createLxcDirectoryTransferStep,
  createLxcFileTransferStep,
  LxcFileTransferError,
  pullLxcFile,
  transferArchive,
  transferDirectory,
} from './transfer.js';

function logger(): StepLogger {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

function context(
  transport: FakeTransport,
  signal: AbortSignal = new AbortController().signal,
): StepExecutionContext<undefined> {
  return {
    operationId: 'op-1',
    input: undefined,
    transport,
    logger: logger(),
    dryRun: false,
    signal,
  };
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

function entry(name: string, content: string): TarEntry {
  return {
    name,
    content: new TextEncoder().encode(content),
    mtime: new Date('2026-11-10T12:00:00.000Z'),
  };
}

describe('tar archive builder', () => {
  it('writes ustar headers, contents and the two end blocks', () => {
    const archive = buildTarArchive([
      {
        ...entry('app.conf', 'hello'),
        mode: '0640',
        uid: 1000,
        gid: 1001,
      },
      entry('nested/deep/config.yaml', 'name: example\n'),
    ]);
    const headers = tarHeaders(archive);
    expect(headers).toHaveLength(2);
    expect(headers[0]!.subarray(0, 9).toString('ascii')).toBe('app.conf\0');
    expect(readOctal(headers[0]!, 100, 8)).toBe(0o640);
    expect(readOctal(headers[0]!, 108, 8)).toBe(1000);
    expect(readOctal(headers[0]!, 116, 8)).toBe(1001);
    expect(readOctal(headers[0]!, 124, 12)).toBe(5);
    expect(headers[0]!.subarray(257, 263).toString('ascii')).toBe('ustar\0');
    expect(
      headers[1]!.subarray(0, 24).toString('ascii').replace(/\0.*$/, ''),
    ).toBe('nested/deep/config.yaml');
    expect(
      Buffer.from(archive)
        .subarray(-1024)
        .every((byte) => byte === 0),
    ).toBe(true);

    const checksum = readOctal(headers[0]!, 148, 8);
    const copy = Buffer.from(headers[0]!);
    copy.fill(0x20, 148, 156);
    const actual = [...copy].reduce((sum, byte) => sum + byte, 0);
    expect(checksum).toBe(actual);
  });

  it('splits long names into the ustar prefix and gzips the archive', () => {
    const name = `${'a'.repeat(120)}/${'b'.repeat(90)}.conf`;
    const archive = buildTarGz([entry(name, 'long')]);
    expect([...archive.subarray(0, 2)]).toEqual([0x1f, 0x8b]);
    const headers = tarHeaders(gunzipSync(archive));
    expect(headers).toHaveLength(1);
    const base = headers[0]!
      .subarray(0, 100)
      .toString('ascii')
      .replace(/\0.*$/, '');
    const prefix = headers[0]!
      .subarray(345, 500)
      .toString('ascii')
      .replace(/\0.*$/, '');
    expect(`${prefix}/${base}`).toBe(name);
  });

  it('rejects invalid modes and impossible names', () => {
    expect(() =>
      buildTarArchive([{ ...entry('a.conf', 'a'), mode: 'rw' }]),
    ).toThrow(TarArchiveError);
    expect(() => buildTarArchive([entry('a/b/c'.repeat(200), 'a')])).toThrow(
      TarArchiveError,
    );
    expect(() =>
      buildTarArchive([{ ...entry('a.conf', 'a'), uid: -1 }]),
    ).toThrow(TarArchiveError);
    expect(() =>
      buildTarArchive([{ ...entry('a.conf', 'a'), mode: '77777' }]),
    ).toThrow(TarArchiveError);
  });
});

function guestFileTransport(): FakeTransport {
  return new FakeTransport()
    .onExec(/^bash -s -- \/var\/tmp\/hacm-/, {})
    .onExec(/^pct exec 112 -- sh -s -- \/etc$/, {})
    .onExec(/^pct push 112 /, {})
    .onExec(/^pct exec 112 -- test -f \/etc\/app.conf$/, {})
    .onExec(/^rm -f -- /, {});
}

describe('LXC file transfer', () => {
  it('pushes a single guest file with pct push and preserves its mode', async () => {
    const transport = guestFileTransport();
    const step = createLxcFileTransferStep({
      target: { kind: 'guest', vmid: 112 },
      destination: '/etc/app.conf',
      content: 'listen=127.0.0.1\n',
      mode: '0640',
      owner: 1000,
      group: 1001,
      token: 'single',
    });

    await expect(step.apply(context(transport))).resolves.toMatchObject({
      destination: '/etc/app.conf',
    });
    expect(
      Buffer.from(
        transport.getFile('/var/tmp/hacm-single.b64')!,
        'base64',
      ).toString(),
    ).toBe('listen=127.0.0.1\n');
    expect(transport.execArgv).toContainEqual([
      'pct',
      'push',
      '112',
      '/var/tmp/hacm-single.upload',
      '/etc/app.conf',
      '--perms',
      '0640',
      '--user',
      '1000',
      '--group',
      '1001',
    ]);
    expect(transport.execArgv).toContainEqual([
      'pct',
      'exec',
      '112',
      '--',
      'sh',
      '-s',
      '--',
      '/etc',
    ]);
    await expect(step.verify(context(transport))).resolves.toMatchObject({
      transferred: true,
    });

    const plain = createLxcFileTransferStep({
      target: { kind: 'guest', vmid: 112 },
      destination: '/etc/plain.conf',
      content: Uint8Array.from([1, 2, 3]),
      token: 'plain',
    });
    transport.onExec(/^pct exec 112 -- sh -s -- \/etc$/, {});
    transport.onExec(/^pct push 112 /, {});
    await plain.apply(context(transport));
    expect(transport.execArgv).toContainEqual([
      'pct',
      'push',
      '112',
      '/var/tmp/hacm-plain.upload',
      '/etc/plain.conf',
      '--perms',
      '0644',
    ]);
  });

  it('installs a host-path file with the shifted ownership', async () => {
    const transport = new FakeTransport()
      .onExec(/^bash -s -- \/staging\/hacm-/, {})
      .onExec(/^test -f \/srv\/data\/app.conf$/, {})
      .onExec(/^rm -f -- /, {});
    await createLxcFileTransferStep({
      target: { kind: 'host' },
      destination: '/srv/data/app.conf',
      content: 'data',
      mode: '0600',
      owner: 100000,
      group: 100001,
      stagingRoot: '/staging',
      token: 'host',
    }).apply(context(transport));

    const install = transport.calls.find(
      (call) =>
        call.kind === 'exec' &&
        call.argv[0] === 'bash' &&
        call.options?.stdin?.includes('install -m') === true,
    );
    expect(install?.kind).toBe('exec');
    if (install?.kind !== 'exec') throw new Error('missing install call');
    expect(install.argv.slice(3)).toEqual([
      '/staging/hacm-host.upload',
      '/srv/data/app.conf',
      '0600',
      '100000',
      '100001',
    ]);
    expect(install.options?.stdin).toContain('install -m "$3" -o "$4" -g "$5"');
  });

  it('syncs a large directory as one tar stream and applies deletes once', async () => {
    const transport = new FakeTransport()
      .onExec(/^bash -s -- \/var\/tmp\/hacm-/, {})
      .onExec(/^pct push 112 /, {})
      .onExec(/^pct exec 112 -- sh -s -- /, {})
      .onExec(/^pct exec 112 -- test -d \/srv\/app$/, {})
      .onExec(/^rm -f -- /, {});
    const files = Array.from({ length: 100 }, (_, index) => ({
      path: `nested/file-${index}.conf`,
      content: `value=${index}`,
      mode: '0644',
    }));
    const step = createLxcDirectoryTransferStep({
      target: { kind: 'guest', vmid: 112 },
      destination: '/srv/app',
      files,
      deletePaths: ['/srv/app/stale-a.conf', '/srv/app/stale-b.conf'],
      token: 'dir',
    });

    await expect(step.apply(context(transport))).resolves.toMatchObject({
      files: 100,
      deleted: 2,
    });
    expect(
      transport.execArgv.filter(
        (argv) => argv[0] === 'pct' && argv[1] === 'push',
      ),
    ).toHaveLength(1);
    expect(
      transport.execArgv.filter(
        (argv) =>
          argv[0] === 'pct' &&
          argv[1] === 'exec' &&
          argv[4] === 'sh' &&
          argv[5] === '-s',
      ),
    ).toHaveLength(1);

    const archiveBase64 = transport.getFile('/var/tmp/hacm-dir.b64');
    expect(archiveBase64).toBeDefined();
    const archive = gunzipSync(Buffer.from(archiveBase64!, 'base64'));
    expect(tarHeaders(archive)).toHaveLength(100);
    await expect(step.verify(context(transport))).resolves.toMatchObject({
      synced: true,
    });
    transport.onExec(/^pct exec 112 -- test -d \/srv\/app$/, {
      exitCode: 1,
    });
    await expect(step.verify(context(transport))).rejects.toBeInstanceOf(
      LxcFileTransferError,
    );
  });

  it('extracts a pushed zip archive inside the guest', async () => {
    const transport = new FakeTransport()
      .onExec(/^bash -s -- \/var\/tmp\/hacm-/, {})
      .onExec(/^pct push 112 /, {})
      .onExec(/^pct exec 112 -- sh -s -- /, {})
      .onExec(/^pct exec 112 -- test -d \/opt\/app$/, {})
      .onExec(/^rm -f -- /, {});
    const step = createLxcArchiveTransferStep({
      target: { kind: 'guest', vmid: 112 },
      destination: '/opt/app',
      archive: Uint8Array.from([1, 2, 3]),
      format: 'zip',
      token: 'archive',
    });
    await step.apply(context(transport));
    const extract = transport.calls.find(
      (call) =>
        call.kind === 'exec' &&
        call.argv[1] === 'exec' &&
        call.argv[4] === 'sh',
    );
    expect(extract?.kind).toBe('exec');
    if (extract?.kind !== 'exec') throw new Error('missing extract call');
    expect(extract.argv.slice(-3)).toEqual([
      '/var/tmp/hacm-archive.zip',
      '/opt/app',
      'zip',
    ]);
    expect(extract.options?.stdin).toContain('unzip -oq');
    await expect(step.verify(context(transport))).resolves.toMatchObject({
      extracted: true,
    });
    transport.onExec(/^pct exec 112 -- test -d \/opt\/app$/, { exitCode: 1 });
    await expect(step.verify(context(transport))).rejects.toBeInstanceOf(
      LxcFileTransferError,
    );
  });

  it('extracts archives and directories directly on the host path', async () => {
    const transport = new FakeTransport()
      .onExec(/^bash -s -- \/var\/tmp\/hacm-/, {})
      .onExec(/^test -d \/srv\/app$/, {})
      .onExec(/^test -f \/srv\/app\.conf$/, {})
      .onExec(/^rm -f -- /, {});

    await transferArchive(
      transport,
      {
        target: { kind: 'host' },
        destination: '/srv/app',
        archive: 'fake-archive',
        format: 'tar.xz',
        token: 'host-archive',
      },
      new AbortController().signal,
    );
    const extract = transport.calls.find(
      (call) =>
        call.kind === 'exec' &&
        call.options?.stdin?.includes('case "$format"') === true,
    );
    expect(extract?.kind).toBe('exec');
    if (extract?.kind !== 'exec') throw new Error('missing host extract');
    expect(extract.options?.stdin).toContain('tar -xpJf');

    await transferDirectory(
      transport,
      {
        target: { kind: 'host' },
        destination: '/srv/app',
        files: [{ path: 'a.conf', content: 'a' }],
        deletePaths: ['/srv/app/stale.conf'],
        token: 'host-dir',
      },
      new AbortController().signal,
    );
    const directory = transport.calls.find(
      (call) =>
        call.kind === 'exec' &&
        call.options?.stdin?.includes('tar -xpzf') === true &&
        call.argv.includes('/srv/app/stale.conf'),
    );
    expect(directory?.kind).toBe('exec');
    if (directory?.kind !== 'exec') throw new Error('missing host sync');
    expect(directory.options?.stdin).toContain('tar -xpzf');
  });

  it('deletes paths without pushing a tar when there are no files', async () => {
    const transport = new FakeTransport().onExec(
      /^pct exec 112 -- rm -f -- /,
      {},
    );
    await createLxcDirectoryTransferStep({
      target: { kind: 'guest', vmid: 112 },
      destination: '/srv/app',
      files: [],
      deletePaths: ['/srv/app/stale.conf'],
    }).apply(context(transport));
    expect(transport.execArgv).toEqual([
      ['pct', 'exec', '112', '--', 'rm', '-f', '--', '/srv/app/stale.conf'],
    ]);
    expect(transport.calls.some((call) => call.kind === 'writeFile')).toBe(
      false,
    );
  });

  it('marks an empty transfer as satisfied and skips writes', async () => {
    const step = createLxcDirectoryTransferStep({
      target: { kind: 'host' },
      destination: '/srv/app',
      files: [],
    });
    expect(await step.check(context(new FakeTransport()))).toEqual({
      status: 'satisfied',
    });
    const deletionOnly = createLxcDirectoryTransferStep({
      target: { kind: 'host' },
      destination: '/srv/app',
      files: [],
      deletePaths: ['/srv/app/stale'],
    });
    expect(await deletionOnly.check(context(new FakeTransport()))).toEqual({
      status: 'required',
    });
    await transferDirectory(new FakeTransport(), {
      target: { kind: 'host' },
      destination: '/srv/app',
      files: [],
    });
  });

  it('carries directory ownership and mtimes into the tar headers', async () => {
    const transport = new FakeTransport()
      .onExec(/^bash -s -- \/var\/tmp\/hacm-/, {})
      .onExec(/^pct push 112 /, {})
      .onExec(/^pct exec 112 -- sh -s -- /, {})
      .onExec(/^rm -f -- /, {});
    await transferDirectory(
      transport,
      {
        target: { kind: 'guest', vmid: 112 },
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
        token: 'owned',
      },
      new AbortController().signal,
    );
    const headers = tarHeaders(
      gunzipSync(
        Buffer.from(transport.getFile('/var/tmp/hacm-owned.b64')!, 'base64'),
      ),
    );
    expect(readOctal(headers[0]!, 108, 8)).toBe(1000);
    expect(readOctal(headers[0]!, 116, 8)).toBe(1001);
  });

  it('pulls a binary file and cleans up the staging file', async () => {
    const transport = new FakeTransport()
      .onExec(/^pct pull 112 \/opt\/app.tar.gz /, {})
      .onExec(/^rm -f -- /, {})
      .setFile(
        '/var/tmp/hacm-pull.pull',
        Buffer.from([0, 1, 255]).toString('base64'),
      );
    const bytes = await pullLxcFile(transport, {
      vmid: 112,
      path: '/opt/app.tar.gz',
      token: 'pull',
      stagingRoot: '/var/tmp',
    });
    expect([...bytes]).toEqual([0, 1, 255]);
    expect(transport.execArgv).toContainEqual([
      'rm',
      '-f',
      '--',
      '/var/tmp/hacm-pull.pull',
    ]);
  });

  it('defaults staging tokens and forwards pull signals and timeouts', async () => {
    class DynamicReadTransport extends FakeTransport {
      public override readFile(): Promise<string> {
        return Promise.resolve(Buffer.from([9, 8, 7]).toString('base64'));
      }
    }
    const transport = new DynamicReadTransport()
      .onExec(/^pct pull 112 \/opt\/app \/var\/tmp\/hacm-/, {})
      .onExec(/^rm -f -- /, {});
    const controller = new AbortController();
    const bytes = await pullLxcFile(transport, {
      vmid: 112,
      path: '/opt/app',
      signal: controller.signal,
      timeoutMs: 5_000,
    });
    expect([...bytes]).toEqual([9, 8, 7]);
    const pull = transport.calls.find(
      (call) => call.kind === 'exec' && call.argv[0] === 'pct',
    );
    expect(pull?.kind === 'exec' ? pull.options?.signal : undefined).toBe(
      controller.signal,
    );
    await expect(
      pullLxcFile(new FakeTransport(), { vmid: 0, path: '/opt/app' }),
    ).rejects.toBeInstanceOf(LxcFileTransferError);
    await expect(
      pullLxcFile(new FakeTransport(), { vmid: 112, path: 'relative' }),
    ).rejects.toBeInstanceOf(LxcFileTransferError);
  });

  it('swallows cleanup failures and reports exit codes without stderr', async () => {
    const transport = new FakeTransport()
      .onExec(/^bash -s -- /, {})
      .onExec(/^rm -f -- /, { exitCode: 1 })
      .onExec(/^test -f /, {});
    await transferDirectory(
      transport,
      {
        target: { kind: 'host' },
        destination: '/srv/app',
        files: [{ path: 'a', content: 'a' }],
        token: 'cleanup',
      },
      new AbortController().signal,
    );

    const failing = new FakeTransport()
      .onExec(/^bash -s -- /, { exitCode: 7 })
      .onExec(/^rm -f -- /, {});
    await expect(
      transferDirectory(failing, {
        target: { kind: 'host' },
        destination: '/srv/app',
        files: [{ path: 'a', content: 'a' }],
        token: 'exit',
      }),
    ).rejects.toThrow('exit code 7');
  });

  it('rejects unsafe paths and reports command failures', async () => {
    const transport = new FakeTransport();
    await expect(
      transferDirectory(transport, {
        target: { kind: 'guest', vmid: 112 },
        destination: '/',
        files: [],
      }),
    ).rejects.toBeInstanceOf(LxcFileTransferError);
    await expect(
      transferDirectory(transport, {
        target: { kind: 'guest', vmid: 0 },
        destination: '/srv/app',
        files: [{ path: '../escape', content: 'x' }],
      }),
    ).rejects.toBeInstanceOf(LxcFileTransferError);
    await expect(
      transferDirectory(transport, {
        target: { kind: 'guest', vmid: 112 },
        destination: '/srv/app',
        files: [{ path: 'safe', content: 'x', mode: 'nope' }],
      }),
    ).rejects.toBeInstanceOf(LxcFileTransferError);
    await expect(
      transferDirectory(transport, {
        target: { kind: 'guest', vmid: 112 },
        destination: '/srv/app',
        files: [{ path: 'safe', content: 'x', owner: -1 }],
      }),
    ).rejects.toBeInstanceOf(LxcFileTransferError);
    await expect(
      transferDirectory(transport, {
        target: { kind: 'guest', vmid: 112 },
        destination: '/srv/app',
        files: [{ path: 'safe', content: 'x' }],
        token: 'bad token',
      }),
    ).rejects.toBeInstanceOf(LxcFileTransferError);

    const failing = new FakeTransport()
      .onExec(/^bash -s -- /, { stderr: 'disk full', exitCode: 1 })
      .onExec(/^rm -f -- /, {});
    await expect(
      transferDirectory(failing, {
        target: { kind: 'host' },
        destination: '/srv/app',
        files: [{ path: 'safe', content: 'x' }],
        token: 'fail',
      }),
    ).rejects.toThrow('disk full');
  });

  it('fails verification when the destination is missing', async () => {
    const transport = new FakeTransport()
      .onExec(/^bash -s -- /, {})
      .onExec(/^rm -f -- /, {})
      .onExec(/^test -f /, { exitCode: 1 });
    const step = createLxcFileTransferStep({
      target: { kind: 'host' },
      destination: '/srv/app.conf',
      content: 'x',
      token: 'verify',
    });
    await step.apply(context(transport));
    await expect(step.verify(context(transport))).rejects.toBeInstanceOf(
      LxcFileTransferError,
    );
  });
});

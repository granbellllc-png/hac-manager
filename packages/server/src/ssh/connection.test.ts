import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { Server } from 'ssh2';
import { SshConnection, escapePosixArg } from './connection.js';
import { HostKeyMismatchError, SshConnectionLostError } from './types.js';
import { TransportAbortedError, TransportFileNotFoundError } from '@hacm/core';

const serverKeys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

const clientKeys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

describe('SshConnection and Pool', () => {
  it('correctly escapes posix arguments', () => {
    expect(escapePosixArg('')).toBe("''");
    expect(escapePosixArg('pct')).toBe('pct');
    expect(escapePosixArg('foo bar')).toBe("'foo bar'");
    expect(escapePosixArg("it's")).toBe("'it'\\''s'");
  });

  it('connects, verifies host key, runs exec, sftp, and handles drops', async () => {
    const files = new Map<string, string>();

    const server = new Server(
      {
        hostKeys: [serverKeys.privateKey],
      },
      (client) => {
        client.on('error', () => {
          // ignore disconnect/kex errors during test
        });
        client.on('authentication', (ctx) => {
          if (ctx.method === 'publickey' || ctx.method === 'password') {
            ctx.accept();
          } else {
            ctx.reject();
          }
        });

        client.on('ready', () => {
          client.on('session', (accept) => {
            const session = accept();

            session.on('exec', (acceptExec, _rejectExec, info) => {
              const stream = acceptExec();
              let stdinData = '';

              stream.on('data', (d: Buffer) => {
                stdinData += d.toString('utf8');
              });

              stream.on('end', () => {
                if (info.command.startsWith('echo ')) {
                  const text = info.command.slice(5).replace(/^'|'$/g, '');
                  stream.write(text + '\n');
                  stream.exit(0);
                  stream.end();
                } else if (info.command === 'cat') {
                  stream.write(stdinData);
                  stream.exit(0);
                  stream.end();
                } else if (info.command === 'fail') {
                  stream.stderr.write('Something went wrong\n');
                  stream.exit(42);
                  stream.end();
                } else if (info.command === 'sleep') {
                  // Do not reply immediately, test timeout
                } else {
                  stream.write('ok\n');
                  stream.exit(0);
                  stream.end();
                }
              });
            });

            session.on('sftp', (acceptSftp) => {
              const sftp = acceptSftp();
              sftp.on('STAT', (reqId, path) => {
                if (files.has(path)) {
                  sftp.attrs(reqId, {
                    mode: 0o644,
                    uid: 0,
                    gid: 0,
                    size: files.get(path)!.length,
                    atime: 1000,
                    mtime: 1000,
                  });
                } else {
                  sftp.status(reqId, 2); // SSH_FX_NO_SUCH_FILE
                }
              });

              sftp.on('OPEN', (reqId, filename, flags) => {
                const handle = Buffer.from(filename);
                if (flags & 0x0002 || flags & 0x0008) {
                  // write/create
                  files.set(filename, '');
                }
                sftp.handle(reqId, handle);
              });

              sftp.on('WRITE', (reqId, handle, _offset, data) => {
                const fn = handle.toString('utf8');
                const prev = files.get(fn) ?? '';
                files.set(fn, prev + data.toString('utf8'));
                sftp.status(reqId, 0); // SSH_FX_OK
              });

              const readHandles = new Set<string>();

              sftp.on('READ', (reqId, handle) => {
                const fn = handle.toString('utf8');
                const content = files.get(fn);
                if (content !== undefined && !readHandles.has(fn)) {
                  readHandles.add(fn);
                  sftp.data(reqId, Buffer.from(content));
                } else {
                  sftp.status(reqId, 1); // SSH_FX_EOF
                }
              });

              sftp.on('CLOSE', (reqId) => {
                sftp.status(reqId, 0);
              });
            });
          });
        });
      },
    );

    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve()),
    );
    const port = (server.address() as { port: number }).port;

    let capturedFingerprint: string | undefined;

    const conn = new SshConnection('test-host', {
      host: '127.0.0.1',
      port,
      username: 'root',
      privateKey: clientKeys.privateKey,
    });

    try {
      // 1. Initial connect (TOFU captures fingerprint)
      await conn.connect();
      expect(conn.state).toBe('connected');
      expect(conn.lastFingerprint).toBeDefined();
      capturedFingerprint = conn.lastFingerprint;

      // 2. Exec echo
      const echoRes = await conn.exec(['echo', 'hello world']);
      expect(echoRes.exitCode).toBe(0);
      expect(echoRes.stdout.trim()).toBe('hello world');

      // 3. Exec with stdin
      const catRes = await conn.exec(['cat'], { stdin: 'line 1\nline 2\n' });
      expect(catRes.exitCode).toBe(0);
      expect(catRes.stdout).toBe('line 1\nline 2\n');

      // 4. Exec with error code & stderr
      const failRes = await conn.exec(['fail']);
      expect(failRes.exitCode).toBe(42);
      expect(failRes.stderr).toContain('Something went wrong');

      // 5. Exec timeout
      const timeoutRes = await conn.exec(['sleep'], { timeoutMs: 50 });
      expect(timeoutRes.timedOut).toBe(true);

      // 6. Exec abort signal
      const ac = new AbortController();
      ac.abort();
      await expect(
        conn.exec(['echo', 'aborted'], { signal: ac.signal }),
      ).rejects.toThrow(TransportAbortedError);

      // 7. SFTP write and stat and read
      await conn.writeFile('/etc/test.txt', 'test file content');
      expect(files.get('/etc/test.txt')).toBe('test file content');
      const readBack = await conn.readFile('/etc/test.txt');
      expect(readBack).toBe('test file content');

      // 8. SFTP read non-existent
      await expect(conn.readFile('/etc/missing.txt')).rejects.toThrow(
        TransportFileNotFoundError,
      );

      await conn.disconnect();
      expect(conn.state).toBe('disconnected');

      // 9. Pinning check: matching fingerprint connects
      const pinnedConn = new SshConnection('test-pinned', {
        host: '127.0.0.1',
        port,
        username: 'root',
        password: 'password123',
        fingerprint: capturedFingerprint,
      });

      await pinnedConn.connect();
      expect(pinnedConn.state).toBe('connected');
      await pinnedConn.disconnect();

      // 10. Pinning check: mismatched fingerprint is blocked!
      const mismatchConn = new SshConnection('test-mismatch', {
        host: '127.0.0.1',
        port,
        username: 'root',
        password: 'password123',
        fingerprint: 'SHA256:WRONG-FINGERPRINT-DOES-NOT-MATCH',
      });

      await expect(mismatchConn.connect()).rejects.toThrow(
        HostKeyMismatchError,
      );
      expect(mismatchConn.state).toBe('error');

      // 11. Re-trust flow enables connection
      mismatchConn.retrustHostKey(capturedFingerprint);
      await mismatchConn.connect();
      expect(mismatchConn.state).toBe('connected');
      await mismatchConn.disconnect();
    } finally {
      await conn.disconnect();
      server.close();
    }
  });

  it('fails pending commands cleanly when connection is dropped', async () => {
    let connectedClient: { end: () => void } | undefined;

    const server = new Server(
      {
        hostKeys: [serverKeys.privateKey],
      },
      (client) => {
        connectedClient = client as unknown as { end: () => void };
        client.on('error', () => {});
        client.on('authentication', (ctx) => ctx.accept());
        client.on('ready', () => {
          client.on('session', (accept) => {
            const session = accept();
            session.on('exec', (acceptExec) => {
              acceptExec();
              // purposefully keep command hanging
            });
          });
        });
      },
    );

    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve()),
    );
    const port = (server.address() as { port: number }).port;

    const conn = new SshConnection('drop-test', {
      host: '127.0.0.1',
      port,
      username: 'root',
      password: 'password123',
    });

    try {
      await conn.connect();
      expect(conn.state).toBe('connected');

      // Start a hanging command
      const execPromise = conn.exec(['hang-command']);

      // Wait a tick for the channel to open
      await new Promise((r) => setTimeout(r, 50));

      // Forcefully end the server-side socket (simulating network cut)
      connectedClient?.end();

      // Pending command MUST fail cleanly with SshConnectionLostError
      await expect(execPromise).rejects.toThrow(SshConnectionLostError);
      expect(conn.state).toBe('disconnected');
    } finally {
      await conn.disconnect().catch(() => {});
      server.close();
    }
  });
});

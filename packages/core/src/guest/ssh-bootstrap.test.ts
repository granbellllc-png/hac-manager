import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { globalSecretRedactor } from '../redaction/index.js';
import { MemoryStepJournal } from '../steps/memory-journal.js';
import { runJournaledSteps } from '../steps/runner.js';
import type { StepExecutionContext, StepLogger } from '../steps/types.js';
import { Secret } from '../tags/secret.js';
import type { ExecOptions, ExecResult, Transport } from '../transport/types.js';
import {
  AUTHORIZED_KEYS_PATH,
  createAuthorizedKeysStep,
  createEnsureSshStep,
  createRootPasswordStep,
  createSshBootstrapSteps,
  SshBootstrapError,
  type SshBootstrapOptions,
} from './ssh-bootstrap.js';

const debianRelease = [
  'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"',
  'ID=debian',
  'VERSION_ID="12"',
].join('\n');

const alpineRelease = [
  'NAME="Alpine Linux"',
  'ID=alpine',
  'VERSION_ID=3.20.3',
].join('\n');

const identifier: SshBootstrapOptions = { hostId: 'pve-01', vmid: 112 };

function logger(): StepLogger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

function context(
  transport: Transport,
  operationId = 'ssh-bootstrap-112',
): StepExecutionContext<undefined> {
  return {
    operationId,
    input: undefined,
    transport,
    logger: logger(),
    dryRun: false,
    signal: new AbortController().signal,
  };
}

function ok(stdout = ''): ExecResult {
  return { exitCode: 0, stdout, stderr: '', timedOut: false };
}

function fail(exitCode = 1, stderr = ''): ExecResult {
  return { exitCode, stdout: '', stderr, timedOut: false };
}

function shellUnquote(value: string): string {
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("'\\''", "'");
  }
  return value;
}

function assignment(script: string, name: string): string | undefined {
  const line = script
    .split('\n')
    .find((candidate) => candidate.startsWith(`${name}=`));
  return line === undefined
    ? undefined
    : shellUnquote(line.slice(name.length + 1));
}

/**
 * Stateful guest fake for the SSH bootstrap. `/etc/shadow` hashes are modelled
 * with SHA-512 rather than real `crypt(3)`, which is enough to exercise the
 * salt-reuse and idempotency logic deterministically.
 */
class SshGuestTransport implements Transport {
  public listening = false;
  public openssl = false;
  public osRelease: string | undefined = debianRelease;
  /** Undefined means root is missing from `/etc/shadow`. */
  public rootHash: string | undefined = '!';
  public authorizedKeys: string | undefined;
  public failInstall = false;
  public failPassword = false;
  public failKeys = false;
  public readonly mutations: string[] = [];
  public readonly scripts: string[] = [];

  public constructor(overrides: Partial<SshGuestTransport> = {}) {
    Object.assign(this, overrides);
  }

  public async exec(
    argv: readonly string[],
    options?: ExecOptions,
  ): Promise<ExecResult> {
    const joined = argv.join(' ');
    if (
      joined === 'cat /etc/os-release' ||
      joined === 'cat /usr/lib/os-release'
    ) {
      return this.osRelease === undefined
        ? fail(1, 'no os-release')
        : ok(this.osRelease);
    }
    if (joined === `cat ${AUTHORIZED_KEYS_PATH}`) {
      return this.authorizedKeys === undefined
        ? fail(1, 'no file')
        : ok(this.authorizedKeys);
    }
    if (argv[0] === '/bin/sh' && argv[1] === '-s') {
      return this.script(options?.stdin ?? '');
    }
    throw new Error(`unexpected command: ${joined}`);
  }

  public async readFile(): Promise<string> {
    throw new Error('not used');
  }

  public async writeFile(): Promise<void> {
    throw new Error('not used');
  }

  private script(script: string): ExecResult {
    this.scripts.push(script);
    if (script.includes('port_hex=')) {
      const needsOpenssl = script.includes('command -v openssl');
      return this.listening && (this.openssl || !needsOpenssl) ? ok() : fail(1);
    }
    if (script.includes('apt-get install') || script.includes('apk add')) {
      if (this.failInstall) return fail(1, 'install failed');
      this.listening = true;
      this.openssl = true;
      this.mutations.push(
        script.includes('apk add') ? 'install-apk' : 'install-debian',
      );
      return ok();
    }
    if (script.includes('current=$(awk')) return this.password(script);
    if (script.includes("<<'HACM_EOF'")) return this.keys(script);
    return ok();
  }

  private password(script: string): ExecResult {
    const password = assignment(script, 'password');
    const fallbackSalt = assignment(script, 'fallback_salt');
    const update = assignment(script, 'update') === '1';
    if (password === undefined || fallbackSalt === undefined) {
      return fail(2, 'malformed password script');
    }
    if (this.rootHash === undefined) {
      return fail(3, 'root is missing from /etc/shadow');
    }
    const salt = this.rootHash.startsWith('$6$')
      ? this.rootHash.slice(3).split('$')[0]!
      : fallbackSalt;
    const expected = `$6$${salt}$${createHash('sha512')
      .update(password)
      .update(salt)
      .digest('hex')}`;
    if (this.rootHash === expected) return ok();
    if (!update) return fail(1);
    if (this.failPassword) {
      return fail(1, `chpasswd rejected ${password}`);
    }
    this.rootHash = expected;
    this.mutations.push('password');
    return ok();
  }

  private keys(script: string): ExecResult {
    if (this.failKeys) return fail(1, 'disk full');
    const marker = "<<'HACM_EOF'\n";
    const start = script.indexOf(marker);
    const end = script.lastIndexOf('\nHACM_EOF');
    const body =
      start >= 0 && end > start + marker.length
        ? script.slice(start + marker.length, end)
        : '';
    this.authorizedKeys = body.length > 0 ? `${body}\n` : '';
    this.mutations.push('keys');
    return ok();
  }
}

describe('createEnsureSshStep', () => {
  it('detects, installs and verifies Debian SSH once', async () => {
    const transport = new SshGuestTransport();
    const step = createEnsureSshStep({});
    expect(step.name).toBe('ensure SSH is listening on port 22');

    await expect(step.check(context(transport))).resolves.toEqual({
      status: 'required',
      detail: { port: 22 },
    });
    await expect(step.apply(context(transport))).resolves.toEqual({
      distribution: 'debian',
      port: 22,
    });
    expect(transport.mutations).toEqual(['install-debian']);
    const install = transport.scripts.find((script) =>
      script.includes('apt-get install'),
    );
    expect(install).toContain('apt-get install -y openssh-server openssl');
    expect(install).toContain('systemctl enable --now ssh');
    await expect(step.verify(context(transport))).resolves.toEqual({
      port: 22,
    });
    await expect(step.check(context(transport))).resolves.toMatchObject({
      status: 'satisfied',
    });
    expect(transport.mutations).toEqual(['install-debian']);
  });

  it('installs Alpine packages through apk', async () => {
    const transport = new SshGuestTransport({
      osRelease: alpineRelease,
      listening: false,
    });
    await expect(
      createEnsureSshStep({}).apply(context(transport)),
    ).resolves.toEqual({ distribution: 'alpine', port: 22 });
    expect(transport.mutations).toEqual(['install-apk']);
    const install = transport.scripts.find((script) =>
      script.includes('apk add'),
    );
    expect(install).toContain('apk add --no-cache openssh openssl shadow');
    expect(install).toContain('rc-update add sshd default');
  });

  it('requires openssl when a root password is configured', async () => {
    const withoutPassword = new SshGuestTransport({
      listening: true,
      openssl: false,
    });
    await expect(
      createEnsureSshStep({}).check(context(withoutPassword)),
    ).resolves.toMatchObject({ status: 'satisfied' });

    const withPassword = new SshGuestTransport({
      listening: true,
      openssl: false,
    });
    await expect(
      createEnsureSshStep({ password: 's3cret' }).check(context(withPassword)),
    ).resolves.toMatchObject({ status: 'required' });
    const probe = withPassword.scripts[0]!;
    expect(probe).toContain('command -v openssl');
  });

  it('probes a custom port', async () => {
    const transport = new SshGuestTransport();
    await createEnsureSshStep({ port: 2222 }).check(context(transport));
    expect(transport.scripts[0]).toContain('printf "%04X" 2222');
    await expect(
      createEnsureSshStep({ port: 2222 }).apply(context(transport)),
    ).resolves.toEqual({ distribution: 'debian', port: 2222 });
  });

  it('reports install and verify failures', async () => {
    const install = new SshGuestTransport({ failInstall: true });
    await expect(
      createEnsureSshStep({}).apply(context(install)),
    ).rejects.toThrow(/Failed to install SSH on the guest: install failed/);

    const notListening = new SshGuestTransport();
    await expect(
      createEnsureSshStep({}).verify(context(notListening)),
    ).rejects.toThrow(/SSH is not listening on port 22 after installation/);
  });

  it('validates the port range', () => {
    for (const port of [0, -1, 65_536, 22.5, Number.NaN]) {
      expect(() => createEnsureSshStep({ port })).toThrow(SshBootstrapError);
    }
    expect(() => createEnsureSshStep({ port: 1 })).not.toThrow();
    expect(() => createEnsureSshStep({ port: 65_535 })).not.toThrow();
  });
});

describe('createRootPasswordStep', () => {
  it('validates the password and stable identity', () => {
    expect(() => createRootPasswordStep({})).toThrow(
      /A root password is required/,
    );
    expect(() => createRootPasswordStep({ password: '' })).toThrow(
      /must not be empty/,
    );
    expect(() => createRootPasswordStep({ password: 'x', vmid: 112 })).toThrow(
      /hostId is required/,
    );
    expect(() =>
      createRootPasswordStep({ password: 'x', hostId: '  ', vmid: 112 }),
    ).toThrow(/hostId is required/);
    expect(() =>
      createRootPasswordStep({ password: 'x', hostId: 'pve-01' }),
    ).toThrow(/vmid is required/);
    expect(() =>
      createRootPasswordStep({ password: 'x', hostId: 'pve-01', vmid: 0 }),
    ).toThrow(/vmid is required/);
    expect(() =>
      createRootPasswordStep({
        password: 'x',
        hostId: 'pve-01',
        vmid: 1.5,
      }),
    ).toThrow(/vmid is required/);
  });

  it('checks, updates and verifies a locked root account', async () => {
    const transport = new SshGuestTransport({ rootHash: '!' });
    const step = createRootPasswordStep({ password: 's3cret', ...identifier });
    expect(step.name).toBe('synchronise the root password');

    await expect(step.check(context(transport))).resolves.toEqual({
      status: 'required',
      detail: { user: 'root' },
    });
    await expect(step.apply(context(transport))).resolves.toEqual({
      user: 'root',
      changed: true,
    });
    expect(transport.mutations).toEqual(['password']);
    expect(transport.rootHash).toMatch(/^\$6\$[^$]+\$/);
    await expect(step.verify(context(transport))).resolves.toEqual({
      user: 'root',
    });
    await expect(step.check(context(transport))).resolves.toMatchObject({
      status: 'satisfied',
    });
    await expect(step.apply(context(transport))).resolves.toEqual({
      user: 'root',
      changed: true,
    });
    expect(transport.mutations).toEqual(['password']);
  });

  it('reuses the salt of an existing SHA-512 hash', async () => {
    const salt = 'existingsalt1234';
    const hash = `$6$${salt}$${createHash('sha512')
      .update('s3cret')
      .update(salt)
      .digest('hex')}`;
    const transport = new SshGuestTransport({ rootHash: hash });
    const step = createRootPasswordStep({ password: 's3cret', ...identifier });
    await expect(step.check(context(transport))).resolves.toMatchObject({
      status: 'satisfied',
    });
    expect(transport.rootHash).toBe(hash);
    expect(transport.mutations).toEqual([]);
  });

  it('derives a deterministic fallback salt per host and vmid', async () => {
    const salts: string[] = [];
    for (const options of [
      { password: 's3cret', hostId: 'pve-01', vmid: 112 },
      { password: 's3cret', hostId: 'pve-01', vmid: 112 },
      { password: 's3cret', hostId: 'pve-01', vmid: 113 },
      { password: 's3cret', hostId: 'pve-02', vmid: 112 },
    ]) {
      const transport = new SshGuestTransport();
      await createRootPasswordStep(options).check(context(transport));
      salts.push(assignment(transport.scripts[0]!, 'fallback_salt')!);
    }
    expect(salts[0]).toBe(salts[1]);
    expect(salts[0]).not.toBe(salts[2]);
    expect(salts[0]).not.toBe(salts[3]);
    expect(salts[0]).toMatch(/^[./0-9A-Za-z]{1,16}$/);
  });

  it('accepts a Secret and redacts it from failures', async () => {
    const secret = new Secret('supersecret');
    const transport = new SshGuestTransport({
      rootHash: '!',
      failPassword: true,
    });
    const step = createRootPasswordStep({ password: secret, ...identifier });
    const error = await step
      .apply(context(transport))
      .then(() => undefined)
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(SshBootstrapError);
    expect((error as Error).message).toContain(
      'Failed to update the root password',
    );
    expect((error as Error).message).toContain('***');
    expect((error as Error).message).not.toContain('supersecret');
    expect(globalSecretRedactor.redact('supersecret')).toBe('***');
  });

  it('reports a missing root entry and check failures', async () => {
    const missing = new SshGuestTransport({ rootHash: undefined });
    await expect(
      createRootPasswordStep({ password: 's3cret', ...identifier }).check(
        context(missing),
      ),
    ).rejects.toThrow(/root is missing from \/etc\/shadow/);

    const failing = new SshGuestTransport();
    failing.exec = async (argv, options) => {
      if (argv[0] === '/bin/sh') return fail(9, '');
      return SshGuestTransport.prototype.exec.call(failing, argv, options);
    };
    await expect(
      createRootPasswordStep({ password: 's3cret', ...identifier }).check(
        context(failing),
      ),
    ).rejects.toThrow(/Could not compare the root password hash: exit code 9/);
  });

  it('reports apply and verify failures', async () => {
    const applyFailure = new SshGuestTransport({
      rootHash: '!',
      failPassword: true,
    });
    await expect(
      createRootPasswordStep({ password: 's3cret', ...identifier }).apply(
        context(applyFailure),
      ),
    ).rejects.toThrow(/Failed to update the root password/);

    const stale = new SshGuestTransport();
    const step = createRootPasswordStep({ password: 's3cret', ...identifier });
    stale.rootHash = `$6$other$${'0'.repeat(64)}`;
    await expect(step.verify(context(stale))).rejects.toThrow(
      /still differs after the update/,
    );
  });
});

describe('createAuthorizedKeysStep', () => {
  it('validates every key as a single line', () => {
    expect(() => createAuthorizedKeysStep([''])).toThrow(
      /authorized_keys\[0\] must not be empty/,
    );
    expect(() => createAuthorizedKeysStep(['   '])).toThrow(
      /must not be empty/,
    );
    expect(() => createAuthorizedKeysStep(['a\nb'])).toThrow(
      /single line without NUL/,
    );
    expect(() => createAuthorizedKeysStep(['a\rb'])).toThrow(
      /single line without NUL/,
    );
    expect(() => createAuthorizedKeysStep(['a\u0000b'])).toThrow(
      /single line without NUL/,
    );
    expect(() => createAuthorizedKeysStep([])).not.toThrow();
  });

  it('writes the declared keys and becomes satisfied', async () => {
    const transport = new SshGuestTransport();
    const step = createAuthorizedKeysStep([
      'ssh-rsa AAA first',
      'ssh-ed25519 BBB second',
    ]);
    expect(step.name).toBe('synchronise root authorized_keys');
    await expect(step.check(context(transport))).resolves.toEqual({
      status: 'required',
      detail: { keys: 2 },
    });
    await expect(step.apply(context(transport))).resolves.toEqual({
      path: AUTHORIZED_KEYS_PATH,
      keys: 2,
    });
    expect(transport.authorizedKeys).toBe(
      'ssh-rsa AAA first\nssh-ed25519 BBB second\n',
    );
    await expect(step.verify(context(transport))).resolves.toEqual({
      path: AUTHORIZED_KEYS_PATH,
    });
    await expect(step.check(context(transport))).resolves.toMatchObject({
      status: 'satisfied',
    });
    expect(transport.mutations).toEqual(['keys']);
  });

  it('trims keys and replaces the file exactly', async () => {
    const transport = new SshGuestTransport({
      authorizedKeys: 'old key\nstale key\n',
    });
    const step = createAuthorizedKeysStep(['  ssh-rsa AAA trimmed  ']);
    await expect(step.check(context(transport))).resolves.toMatchObject({
      status: 'required',
    });
    await step.apply(context(transport));
    expect(transport.authorizedKeys).toBe('ssh-rsa AAA trimmed\n');
  });

  it('writes an empty file for an empty key list', async () => {
    const transport = new SshGuestTransport();
    const step = createAuthorizedKeysStep([]);
    await step.apply(context(transport));
    expect(transport.authorizedKeys).toBe('');
    await expect(step.check(context(transport))).resolves.toMatchObject({
      status: 'satisfied',
    });
  });

  it('reports write and verify failures', async () => {
    const writeFailure = new SshGuestTransport({ failKeys: true });
    await expect(
      createAuthorizedKeysStep(['ssh-rsa AAA']).apply(context(writeFailure)),
    ).rejects.toThrow(/Failed to write '\/root\/\.ssh\/authorized_keys'/);

    const transport = new SshGuestTransport();
    await expect(
      createAuthorizedKeysStep(['ssh-rsa AAA']).verify(context(transport)),
    ).rejects.toThrow(/does not match the declared keys after writing/);
  });
});

describe('createSshBootstrapSteps', () => {
  it('builds only the ensure step by default', () => {
    expect(createSshBootstrapSteps({}).map((step) => step.name)).toEqual([
      'ensure SSH is listening on port 22',
    ]);
  });

  it('orders ensure, password and authorized_keys steps', () => {
    expect(
      createSshBootstrapSteps({
        password: 's3cret',
        authorizedKeys: ['ssh-rsa AAA'],
        ...identifier,
      }).map((step) => step.name),
    ).toEqual([
      'ensure SSH is listening on port 22',
      'synchronise the root password',
      'synchronise root authorized_keys',
    ]);
  });

  it('makes no changes on a second run', async () => {
    const transport = new SshGuestTransport({ rootHash: '!' });
    const steps = createSshBootstrapSteps({
      password: 's3cret',
      authorizedKeys: ['ssh-rsa AAA'],
      ...identifier,
    });

    const first = await runJournaledSteps({
      ...context(transport),
      steps,
      journal: new MemoryStepJournal(),
    });
    expect(first.entries.map((entry) => entry.status)).toEqual([
      'completed',
      'completed',
      'completed',
    ]);
    for (const entry of first.entries) {
      expect(entry.result).toHaveProperty('apply');
    }
    expect(transport.mutations).toEqual(['install-debian', 'password', 'keys']);
    const hashAfterFirstRun = transport.rootHash;

    const second = await runJournaledSteps({
      ...context(transport, 'ssh-bootstrap-112-second'),
      steps,
      journal: new MemoryStepJournal(),
    });
    expect(second.entries.map((entry) => entry.status)).toEqual([
      'completed',
      'completed',
      'completed',
    ]);
    for (const entry of second.entries) {
      expect(entry.result).not.toHaveProperty('apply');
    }
    expect(transport.mutations).toEqual(['install-debian', 'password', 'keys']);
    expect(transport.rootHash).toBe(hashAfterFirstRun);
  });
});

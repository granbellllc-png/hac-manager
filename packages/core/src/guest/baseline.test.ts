import { describe, expect, it } from 'vitest';
import type { GuestDeployment } from '../schema/deployment.js';
import { MemoryStepJournal } from '../steps/memory-journal.js';
import { runJournaledSteps } from '../steps/runner.js';
import type { StepExecutionContext, StepLogger } from '../steps/types.js';
import { FakeTransport } from '../transport/fake.js';
import type { ExecOptions, ExecResult, Transport } from '../transport/types.js';
import {
  createGuestBaselineSteps,
  createIpv6Step,
  createPackageUpgradeStep,
  createUpdateCommandSteps,
  detectGuestOs,
  GuestBaselineError,
  IPV6_SYSCTL_PATH,
  packageUpgradeScript,
  parseOsRelease,
  planIpv6Policy,
  resolveGuestOs,
} from './baseline.js';

const debianRelease = [
  'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"',
  'NAME="Debian GNU/Linux"',
  'VERSION_ID="12"',
  'VERSION="12 (bookworm)"',
  'ID=debian',
  'HOME_URL="https://www.debian.org/"',
].join('\n');

const ubuntuRelease = [
  'PRETTY_NAME="Ubuntu 24.04.1 LTS"',
  'NAME="Ubuntu"',
  'VERSION_ID="24.04"',
  'ID=ubuntu',
  'ID_LIKE=debian',
].join('\n');

const alpineRelease = [
  'NAME="Alpine Linux"',
  'ID=alpine',
  'VERSION_ID=3.20.3',
  'PRETTY_NAME="Alpine Linux v3.20"',
].join('\n');

function lxc(overrides: Partial<GuestDeployment> = {}): GuestDeployment {
  return {
    id: 112,
    name: 'example',
    type: 'lxc',
    cpu: 1,
    ram: 512,
    disks: [{ name: 'rootfs', storage: 'local-lvm', size_gb: 8 }],
    network: [{ index: 0, name: 'eth0', bridge: 'vmbr0' }],
    ...overrides,
  } as GuestDeployment;
}

function logger(): StepLogger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

function context(
  transport: Transport,
  operationId = 'baseline-112',
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

interface Call {
  readonly argv: readonly string[];
  readonly stdin?: string | undefined;
}

/** Stateful fake for the guest baseline scripts. */
class BaselineTransport implements Transport {
  public os: string | undefined = debianRelease;
  public fileContent: string | undefined;
  public active = false;
  public failWrite = false;
  public failSysctl = false;
  public failPackage = false;
  public failCommand = false;
  public readonly calls: Call[] = [];

  private result(exitCode = 0, stdout = '', stderr = ''): ExecResult {
    return { exitCode, stdout, stderr, timedOut: false };
  }

  private script(stdin: string | undefined): ExecResult {
    const script = stdin ?? '';
    if (script.includes('cat > "$tmp" <<\'HACM_EOF\'')) {
      if (this.failWrite) return this.result(1, '', 'cannot write');
      const match = /<<'HACM_EOF'\n([\s\S]*?)\nHACM_EOF/.exec(script);
      this.fileContent = `${match?.[1] ?? ''}\n`;
      return this.result();
    }
    if (script.includes('apt-get')) {
      return this.failPackage
        ? this.result(1, '', 'dpkg locked')
        : this.result(0, '0 upgraded, 0 newly installed, 0 to remove.');
    }
    if (script.includes('apk upgrade')) {
      return this.failPackage
        ? this.result(1, '', 'apk failed')
        : this.result(0, 'OK: 12 MiB');
    }
    return this.failCommand
      ? this.result(1, '', 'command failed')
      : this.result(0, 'updated');
  }

  public async exec(
    argv: readonly string[],
    options?: ExecOptions,
  ): Promise<ExecResult> {
    this.calls.push({ argv, stdin: options?.stdin });
    const joined = argv.join(' ');
    if (
      joined === 'cat /etc/os-release' ||
      joined === 'cat /usr/lib/os-release'
    ) {
      return this.os === undefined
        ? this.result(1, '', 'missing os-release')
        : this.result(0, this.os);
    }
    if (joined === `cat ${IPV6_SYSCTL_PATH}`) {
      return this.fileContent === undefined
        ? this.result(1, '', 'no file')
        : this.result(0, this.fileContent);
    }
    if (joined === `sysctl -p ${IPV6_SYSCTL_PATH}`) {
      if (this.failSysctl) return this.result(1, '', 'sysctl denied');
      this.active = this.fileContent?.includes('= 1') ?? false;
      return this.result();
    }
    if (joined.startsWith('cat /proc/sys/net/ipv6/conf/')) {
      return this.result(0, this.active ? '1\n' : '0\n');
    }
    if (joined === '/bin/sh -s') return this.script(options?.stdin);
    throw new Error(`unexpected command: ${joined}`);
  }

  public async readFile(): Promise<string> {
    throw new Error('not used');
  }

  public async writeFile(): Promise<void> {
    throw new Error('not used');
  }
}

describe('parseOsRelease', () => {
  it('parses Debian, Ubuntu and Alpine fixtures', () => {
    expect(parseOsRelease(debianRelease)).toEqual({
      id: 'debian',
      idLike: [],
      versionId: '12',
      prettyName: 'Debian GNU/Linux 12 (bookworm)',
    });
    expect(parseOsRelease(ubuntuRelease)).toEqual({
      id: 'ubuntu',
      idLike: ['debian'],
      versionId: '24.04',
      prettyName: 'Ubuntu 24.04.1 LTS',
    });
    expect(parseOsRelease(alpineRelease)).toEqual({
      id: 'alpine',
      idLike: [],
      versionId: '3.20.3',
      prettyName: 'Alpine Linux v3.20',
    });
  });

  it('handles quoting, exports, comments and unknown lines', () => {
    const release = parseOsRelease(
      [
        '# comment',
        'export ID="Alpine"',
        "ID_LIKE='alpine other'",
        'PRETTY_NAME="An \\"escaped\\" name"',
        'BAD LINE',
        'EMPTY=',
      ].join('\r\n'),
    );
    expect(release.id).toBe('alpine');
    expect(release.idLike).toEqual(['alpine', 'other']);
    expect(release.prettyName).toBe('An "escaped" name');
    expect(release.versionId).toBeUndefined();
  });

  it('rejects a release without an ID', () => {
    expect(() => parseOsRelease('NAME="No id"')).toThrow(GuestBaselineError);
    expect(() => parseOsRelease('ID=')).toThrow(/no ID/);
  });
});

describe('resolveGuestOs', () => {
  it('maps supported distributions to a package family', () => {
    expect(resolveGuestOs(parseOsRelease(debianRelease))).toMatchObject({
      distribution: 'debian',
      family: 'debian',
    });
    expect(resolveGuestOs(parseOsRelease(ubuntuRelease))).toMatchObject({
      distribution: 'ubuntu',
      family: 'debian',
    });
    expect(resolveGuestOs(parseOsRelease(alpineRelease))).toMatchObject({
      distribution: 'alpine',
      family: 'alpine',
    });
  });

  it('accepts derivatives through ID_LIKE', () => {
    const mint = parseOsRelease(
      'ID=linuxmint\nID_LIKE="ubuntu debian"\nVERSION_ID=22',
    );
    expect(resolveGuestOs(mint)).toMatchObject({
      distribution: 'ubuntu',
      family: 'debian',
    });
  });

  it('rejects unsupported distributions with actionable detail', () => {
    expect(() =>
      resolveGuestOs(parseOsRelease('ID=fedora\nID_LIKE="rhel"')),
    ).toThrow(/Unsupported guest distribution 'fedora'.*ID_LIKE=rhel/);
    expect(() => resolveGuestOs(parseOsRelease('ID=arch'))).toThrow(
      /Unsupported guest distribution 'arch'\./,
    );
  });
});

describe('detectGuestOs', () => {
  it('reads /etc/os-release through the guest transport', async () => {
    const transport = new FakeTransport().onExec('cat /etc/os-release', {
      stdout: alpineRelease,
    });
    await expect(detectGuestOs(transport)).resolves.toMatchObject({
      distribution: 'alpine',
      family: 'alpine',
    });
    const call = transport.calls[0];
    expect(call?.kind === 'exec' ? call.options?.timeoutMs : undefined).toBe(
      15_000,
    );
  });

  it('falls back to /usr/lib/os-release', async () => {
    const transport = new FakeTransport()
      .onExec('cat /usr/lib/os-release', { stdout: ubuntuRelease })
      .onExec('cat /etc/os-release', { exitCode: 1, stderr: 'missing' });
    await expect(detectGuestOs(transport)).resolves.toMatchObject({
      distribution: 'ubuntu',
    });
  });

  it('reports both failures and forwards signal and timeout overrides', async () => {
    const controller = new AbortController();
    const transport = new FakeTransport()
      .onExec('cat /usr/lib/os-release', {
        exitCode: 1,
        stderr: 'missing',
      })
      .onExec('cat /etc/os-release', { exitCode: 2, stderr: 'denied' });
    await expect(
      detectGuestOs(transport, {
        signal: controller.signal,
        timeoutMs: 500,
      }),
    ).rejects.toThrow(/Could not read .*: missing/);
    const calls = transport.calls.filter((call) => call.kind === 'exec');
    expect(
      calls[0]?.kind === 'exec' ? calls[0].options?.signal : undefined,
    ).toBe(controller.signal);
  });
});

describe('planIpv6Policy', () => {
  it('does nothing when no interface declares IPv6', () => {
    expect(planIpv6Policy([{ index: 0 }])).toBeUndefined();
  });

  it('disables IPv6 only when every declared network disables it', () => {
    const disabled = planIpv6Policy([
      { index: 0, ipv6: 'disabled' },
      { index: 1, ipv6: 'disabled' },
    ]);
    expect(disabled?.disable).toBe(true);
    expect(disabled?.path).toBe(IPV6_SYSCTL_PATH);
    expect(disabled?.content).toContain('net.ipv6.conf.all.disable_ipv6 = 1');
    expect(disabled?.content).toContain(
      'net.ipv6.conf.default.disable_ipv6 = 1',
    );
    expect(disabled?.content).toContain('net.ipv6.conf.lo.disable_ipv6 = 1');

    expect(
      planIpv6Policy([
        { index: 0, ipv6: 'disabled' },
        { index: 1, ipv6: 'auto' },
      ])?.disable,
    ).toBe(false);
    expect(planIpv6Policy([{ index: 0, ipv6: 'dhcp' }])?.content).toContain(
      'disable_ipv6 = 0',
    );
  });
});

describe('createIpv6Step', () => {
  it('writes and applies the policy idempotently', async () => {
    const transport = new BaselineTransport();
    const policy = planIpv6Policy([{ index: 0, ipv6: 'disabled' }])!;
    const step = createIpv6Step(policy);
    await expect(step.check(context(transport))).resolves.toMatchObject({
      status: 'required',
    });
    await expect(step.apply(context(transport))).resolves.toEqual({
      path: IPV6_SYSCTL_PATH,
      disable: true,
    });
    expect(transport.fileContent).toBe(policy.content);
    expect(transport.active).toBe(true);
    await expect(step.verify(context(transport))).resolves.toEqual({
      disable: true,
    });
    await expect(step.check(context(transport))).resolves.toMatchObject({
      status: 'satisfied',
    });
  });

  it('also enables IPv6 again', async () => {
    const transport = new BaselineTransport();
    const policy = planIpv6Policy([{ index: 0, ipv6: 'auto' }])!;
    const step = createIpv6Step(policy);
    await step.apply(context(transport));
    expect(policy.content).toContain('disable_ipv6 = 0');
    await expect(step.verify(context(transport))).resolves.toEqual({
      disable: false,
    });
  });

  it('reports write, apply and verify failures', async () => {
    const policy = planIpv6Policy([{ index: 0, ipv6: 'disabled' }])!;
    const writeFailure = new BaselineTransport();
    writeFailure.failWrite = true;
    await expect(
      createIpv6Step(policy).apply(context(writeFailure)),
    ).rejects.toThrow(/Failed to write .*: cannot write/);

    const sysctlFailure = new BaselineTransport();
    sysctlFailure.failSysctl = true;
    await expect(
      createIpv6Step(policy).apply(context(sysctlFailure)),
    ).rejects.toThrow(/Failed to apply .*: sysctl denied/);

    const mismatched = new BaselineTransport();
    await createIpv6Step(policy).apply(context(mismatched));
    mismatched.active = false;
    await expect(
      createIpv6Step(policy).verify(context(mismatched)),
    ).rejects.toThrow(/IPv6 is not disabled/);
  });

  it('falls back to the exit code when stderr is empty', async () => {
    const transport = new BaselineTransport();
    transport.exec = async (argv, options) => {
      if (argv.join(' ') === '/bin/sh -s') {
        return { exitCode: 1, stdout: '', stderr: '', timedOut: false };
      }
      return BaselineTransport.prototype.exec.call(transport, argv, options);
    };
    const policy = planIpv6Policy([{ index: 0, ipv6: 'disabled' }])!;
    await expect(
      createIpv6Step(policy).apply(context(transport)),
    ).rejects.toThrow(/exit code 1/);
  });
});

describe('package upgrades', () => {
  it('builds the package-manager script per OS family', () => {
    const debian = packageUpgradeScript(
      resolveGuestOs(parseOsRelease(debianRelease)),
    );
    expect(debian).toContain('DEBIAN_FRONTEND=noninteractive');
    expect(debian).toContain('apt-get update -qq');
    expect(debian).toContain('apt-get -y');
    expect(debian).toContain('upgrade');

    const alpine = packageUpgradeScript(
      resolveGuestOs(parseOsRelease(alpineRelease)),
    );
    expect(alpine).toContain('apk update');
    expect(alpine).toContain('apk upgrade');
    expect(alpine).not.toContain('apt-get');
  });

  it('detects the OS and upgrades Debian packages', async () => {
    const transport = new BaselineTransport();
    const step = createPackageUpgradeStep();
    await expect(step.check(context(transport))).resolves.toEqual({
      status: 'required',
      detail: { distribution: 'debian' },
    });
    await expect(step.apply(context(transport))).resolves.toEqual({
      distribution: 'debian',
      family: 'debian',
    });
    const script = transport.calls.find(
      (call) => call.argv.join(' ') === '/bin/sh -s',
    );
    expect(script?.stdin).toContain('apt-get update -qq');
    await expect(step.verify(context(transport))).resolves.toEqual({
      distribution: 'debian',
    });
  });

  it('upgrades Alpine packages through apk', async () => {
    const transport = new BaselineTransport();
    transport.os = alpineRelease;
    await expect(
      createPackageUpgradeStep().apply(context(transport)),
    ).resolves.toEqual({ distribution: 'alpine', family: 'alpine' });
    const script = transport.calls.find(
      (call) => call.argv.join(' ') === '/bin/sh -s',
    );
    expect(script?.stdin).toContain('apk upgrade');
  });

  it('fails on package errors and unsupported guests', async () => {
    const transport = new BaselineTransport();
    transport.failPackage = true;
    await expect(
      createPackageUpgradeStep().apply(context(transport)),
    ).rejects.toThrow(/Package upgrade failed on debian: dpkg locked/);

    const unsupported = new BaselineTransport();
    unsupported.os = 'ID=fedora';
    await expect(
      createPackageUpgradeStep().check(context(unsupported)),
    ).rejects.toThrow(/Unsupported guest distribution/);
  });
});

describe('update commands', () => {
  it('creates one journaled step per command', async () => {
    const transport = new BaselineTransport();
    const steps = createUpdateCommandSteps([
      'docker compose up -d --remove-orphans',
      'systemctl enable --now app.service',
    ]);
    expect(steps.map((step) => step.name)).toEqual([
      'update command 1: docker compose up -d --remove-orphans',
      'update command 2: systemctl enable --now app.service',
    ]);
    await expect(steps[0]!.check(context(transport))).resolves.toEqual({
      status: 'required',
    });
    await expect(steps[0]!.apply(context(transport))).resolves.toEqual({
      index: 0,
      stdout: 'updated',
    });
    expect(transport.calls[0]?.stdin).toBe(
      'docker compose up -d --remove-orphans\n',
    );
    await expect(steps[0]!.verify(context(transport))).resolves.toEqual({
      index: 0,
    });
  });

  it('truncates long command labels and reports failures', async () => {
    const transport = new BaselineTransport();
    transport.failCommand = true;
    const steps = createUpdateCommandSteps([`echo ${'x'.repeat(200)}`]);
    expect(steps[0]?.name.length).toBeLessThan(110);
    await expect(steps[0]!.apply(context(transport))).rejects.toThrow(
      /Update command 1 failed: command failed/,
    );
  });
});

describe('createGuestBaselineSteps', () => {
  const prerequisites = { backupCompleted: true, identityVerified: true };

  it('refuses to build steps without backup and identity proof', () => {
    expect(() =>
      createGuestBaselineSteps(lxc(), {
        prerequisites: { backupCompleted: false, identityVerified: true },
      }),
    ).toThrow(/require a completed backup and a passed identity check/);
  });

  it('builds IPv6, package and update steps in order', () => {
    const steps = createGuestBaselineSteps(
      lxc({
        network: [{ index: 0, name: 'eth0', ipv6: 'disabled' }],
        update_commands: ['systemctl restart app'],
      }),
      { prerequisites },
    );
    expect(steps.map((step) => step.name)).toEqual([
      'disable IPv6 in the guest',
      'upgrade guest OS packages',
      'update command 1: systemctl restart app',
    ]);
  });

  it('omits unrequested steps', () => {
    const steps = createGuestBaselineSteps(lxc(), {
      prerequisites,
      packageUpgrade: false,
    });
    expect(steps).toEqual([]);
  });

  it('runs as a complete journaled baseline job', async () => {
    const transport = new BaselineTransport();
    const steps = createGuestBaselineSteps(
      lxc({
        network: [{ index: 0, name: 'eth0', ipv6: 'disabled' }],
        update_commands: ['echo baseline'],
      }),
      { prerequisites },
    );
    const journal = new MemoryStepJournal();
    const result = await runJournaledSteps({
      ...context(transport),
      steps,
      journal,
    });
    expect(result.entries.map((entry) => entry.status)).toEqual([
      'completed',
      'completed',
      'completed',
    ]);
    expect(transport.active).toBe(true);
    expect(transport.fileContent).toContain('disable_ipv6 = 1');
    expect(
      transport.calls.some(
        (call) =>
          call.argv.join(' ') === '/bin/sh -s' &&
          call.stdin?.includes('apt-get'),
      ),
    ).toBe(true);
  });
});

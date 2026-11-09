import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  managedGuestUuid,
  MANAGED_GUEST_TAG,
  type ExecOptions,
  type ExecResult,
  type GuestDeployment,
} from '@hacm/core';
import type { HostConnectionRouter } from '../router/router.js';
import type { LiveGuestDetail, LiveGuestSummary } from '../inventory/types.js';
import type { HostInventory } from '../inventory/types.js';
import { GuestLifecycleService } from './service.js';
import {
  GuestIdentityCheckError,
  GuestIdentityError,
  GuestNotFoundError,
  GuestProtectionEnabledError,
  GuestStateUnavailableError,
  GuestStoppedIdentityError,
  ProtectedGuestError,
} from './types.js';

const tempDirs: string[] = [];

interface FixtureOptions {
  readonly vmid?: number;
  readonly status?: string;
  readonly tags?: readonly string[];
  readonly description?: string;
  readonly protection?: boolean;
  readonly identityChecks?: readonly string[];
  readonly withDeployment?: boolean;
  readonly withProtectedGuest?: boolean;
}

interface ExecCall {
  readonly argv: readonly string[];
  readonly options?: ExecOptions | undefined;
}

async function createFixture(options: FixtureOptions = {}) {
  const vmid = options.vmid ?? 112;
  const dataDir = await mkdtemp(join(tmpdir(), 'hacm-guests-'));
  tempDirs.push(dataDir);
  await mkdir(join(dataDir, 'hosts', 'pve-01'), { recursive: true });
  await writeFile(
    join(dataDir, 'hosts', 'pve-01', 'host.yaml'),
    `schema_version: 1
id: pve-01
name: PVE 01
type: proxmox
index: 1
connection:
  ssh:
    host: 192.0.2.1
`,
    'utf8',
  );
  if (options.withDeployment !== false) {
    await mkdir(join(dataDir, 'hosts', 'pve-01', `${vmid}-example-lxc`), {
      recursive: true,
    });
    const lines = [
      'schema_version: 1',
      `id: ${vmid}`,
      'name: example-lxc',
      'type: lxc',
      'cpu: 2',
      'ram: 1024',
      'disks: []',
      'network: []',
      ...(options.protection ? ['protection: true'] : []),
      ...(options.identityChecks && options.identityChecks.length > 0
        ? [
            'identity_checks:',
            ...options.identityChecks.map((check) => `  - ${check}`),
          ]
        : []),
    ];
    await writeFile(
      join(
        dataDir,
        'hosts',
        'pve-01',
        `${vmid}-example-lxc`,
        'deployment.yaml',
      ),
      `${lines.join('\n')}\n`,
      'utf8',
    );
  }

  let status = options.status ?? 'running';
  let tags = [...(options.tags ?? [])];
  let description = options.description;
  const calls: ExecCall[] = [];
  let execHandler: (
    argv: readonly string[],
    options?: ExecOptions,
  ) => Partial<ExecResult> = () => ({ exitCode: 0 });
  let powerResult: { upid?: string; source: 'api' | 'ssh' } = {
    source: 'ssh',
  };
  const waitForTask = vi.fn(async () => ({
    status: 'stopped' as const,
  }));

  const deployment = (): GuestDeployment =>
    ({
      id: vmid,
      name: 'example-lxc',
      type: 'lxc',
      cpu: 2,
      ram: 1024,
      disks: [],
      network: [],
      ...(tags.length > 0 ? { tags } : {}),
      ...(description ? { extra: { description } } : {}),
    }) as GuestDeployment;

  const summary = (): LiveGuestSummary => ({
    hostId: 'pve-01',
    vmid,
    name: 'example-lxc',
    type: 'lxc',
    status,
    node: 'pve-01',
    ...(tags.length > 0 ? { tags } : {}),
  });

  let inventoryError: string | undefined;
  let includeSummary = true;
  const inventory = {
    async getHostInventory(): Promise<HostInventory> {
      return {
        hostId: 'pve-01',
        name: 'PVE 01',
        status: inventoryError !== undefined ? 'error' : 'online',
        guests: includeSummary ? [summary()] : [],
        channels: {
          ssh: { ok: true, status: 'connected' },
          api: { ok: true, status: 'connected' },
        },
        lastRefreshedAt: new Date().toISOString(),
        ...(inventoryError ? { error: inventoryError } : {}),
      };
    },
    async getGuestLiveConfig(): Promise<LiveGuestDetail> {
      const canonical = deployment();
      return {
        summary: summary(),
        rawConfig: 'hostname: example-lxc',
        canonicalConfig: canonical,
        source: 'api',
      };
    },
    invalidate: vi.fn(),
  };

  const router = {
    async exec(
      argv: readonly string[],
      execOptions?: ExecOptions,
    ): Promise<ExecResult> {
      calls.push({ argv, options: execOptions });
      const result = execHandler(argv, execOptions);
      return {
        exitCode: result.exitCode ?? 0,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        timedOut: result.timedOut ?? false,
      };
    },
    async powerAction() {
      return powerResult;
    },
    client: { waitForTask },
  } as unknown as HostConnectionRouter;

  const connections = {
    async getRouter() {
      return router;
    },
  };

  const service = new GuestLifecycleService({
    inventory,
    connections,
    hostRegistry: { dataDir },
    ...(options.withProtectedGuest === false
      ? {}
      : { protectedGuest: { hostId: 'pve-01', vmid: 900 } }),
  });

  return {
    dataDir,
    service,
    inventory,
    calls,
    waitForTask,
    setStatus(next: string) {
      status = next;
    },
    setTags(next: readonly string[]) {
      tags = [...next];
    },
    setDescription(next: string | undefined) {
      description = next;
    },
    setEnvironmentError(message: string | undefined) {
      inventoryError = message;
    },
    setIncludeSummary(value: boolean) {
      includeSummary = value;
    },
    setExecHandler(
      handler: (
        argv: readonly string[],
        options?: ExecOptions,
      ) => Partial<ExecResult>,
    ) {
      execHandler = handler;
    },
    setPowerResult(next: { upid?: string; source: 'api' | 'ssh' }) {
      powerResult = next;
    },
  };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('GuestLifecycleService', () => {
  it('blocks the guest hosting HAC Manager', async () => {
    const fixture = await createFixture();
    expect(fixture.service.isSelfManaged('pve-01', 900)).toBe(true);
    expect(fixture.service.isSelfManaged('pve-02', 900)).toBe(false);
    expect(fixture.service.isSelfManaged('pve-01', 112)).toBe(false);
    expect(() => fixture.service.assertNotSelfManaged('pve-01', 900)).toThrow(
      ProtectedGuestError,
    );
    await expect(() =>
      fixture.service.assertNotSelfManaged('pve-01', 112),
    ).not.toThrow();
  });

  it('works without a configured self-managed guest', async () => {
    const fixture = await createFixture({ withProtectedGuest: false });
    expect(fixture.service.isSelfManaged('pve-01', 900)).toBe(false);
  });

  it('reads snapshots from inventory and probes config files when the summary is stale', async () => {
    const fixture = await createFixture();
    const snapshot = await fixture.service.requireSnapshot('pve-01', 112);
    expect(snapshot).toMatchObject({
      hostId: 'pve-01',
      vmid: 112,
      type: 'lxc',
      status: 'running',
    });
    expect(snapshot.deployment.name).toBe('example-lxc');

    fixture.setIncludeSummary(false);
    fixture.setExecHandler((argv) => ({
      exitCode: argv[2] === '/etc/pve/local/lxc/112.conf' ? 0 : 1,
    }));
    const probed = await fixture.service.requireSnapshot('pve-01', 112);
    expect(probed).toMatchObject({ status: 'unknown', type: 'lxc' });
    expect(fixture.calls[0]?.argv).toEqual([
      'test',
      '-f',
      '/etc/pve/local/lxc/112.conf',
    ]);

    await expect(
      fixture.service.requireSnapshot('pve-01', 999),
    ).rejects.toBeInstanceOf(GuestNotFoundError);

    fixture.setIncludeSummary(false);
    fixture.setEnvironmentError('ssh offline');
    await expect(
      fixture.service.getSnapshot('pve-01', 112),
    ).rejects.toBeInstanceOf(GuestStateUnavailableError);

    fixture.setEnvironmentError('');
    await expect(fixture.service.getSnapshot('pve-01', 112)).rejects.toThrow(
      'inventory is unavailable',
    );
  });

  it('reports missing, unmanaged and verified identities with optional checks', async () => {
    const uuid = managedGuestUuid('pve-01', 112);
    const fixture = await createFixture();
    expect(await fixture.service.getIdentityReport('pve-01', 999)).toBeNull();

    const missing = await fixture.service.getIdentityReport('pve-01', 112);
    expect(missing).toMatchObject({ status: 'unmanaged', managed: false });

    fixture.setTags([MANAGED_GUEST_TAG]);
    fixture.setDescription(`Owner\nhacm-managed: ${uuid}`);
    const verified = await fixture.service.getIdentityReport('pve-01', 112);
    expect(verified).toMatchObject({
      status: 'verified',
      managed: true,
      expectedUuid: uuid,
      actualUuid: uuid,
      checks: [],
    });

    fixture.setExecHandler(() => ({ exitCode: 0 }));
    const checked = await fixture.service.getIdentityReport('pve-01', 112, {
      runIdentityChecks: false,
    });
    expect(checked?.checks).toEqual([]);

    const withChecks = await createFixture({
      tags: [MANAGED_GUEST_TAG],
      description: `hacm-managed: ${uuid}`,
      identityChecks: ['test -d /opt/app'],
    });
    const report = await withChecks.service.getIdentityReport('pve-01', 112, {
      runIdentityChecks: true,
    });
    expect(report?.checks).toEqual([
      expect.objectContaining({ ok: true, exitCode: 0 }),
    ]);
    expect(withChecks.calls[0]).toMatchObject({
      argv: ['pct', 'exec', '112', '--', '/bin/sh', '-s'],
      options: { stdin: 'test -d /opt/app\n' },
    });

    withChecks.setExecHandler(() => ({
      exitCode: 1,
      stderr: 'not found',
    }));
    const failed = await withChecks.service.getIdentityReport('pve-01', 112, {
      runIdentityChecks: true,
    });
    expect(failed?.checks[0]).toMatchObject({
      ok: false,
      exitCode: 1,
      stderr: 'not found',
    });
  });

  it('reports a missing live guest while the YAML is still present', async () => {
    const fixture = await createFixture();
    fixture.setIncludeSummary(false);
    fixture.setExecHandler(() => ({ exitCode: 1 }));
    const report = await fixture.service.getIdentityReport('pve-01', 112);
    expect(report).toMatchObject({ status: 'missing', managed: false });
    expect(report?.messages[0]).toContain('does not exist');
  });

  it('allows mutations when the guest has no YAML yet', async () => {
    const fixture = await createFixture({ withDeployment: false });
    await expect(
      fixture.service.verifyForMutation('pve-01', 112, {
        operation: 'guest.update',
      }),
    ).resolves.toMatchObject({ vmid: 112 });
  });

  it('guards mutations on identity, protection and stopped guests', async () => {
    const uuid = managedGuestUuid('pve-01', 112);
    const fixture = await createFixture({
      tags: [MANAGED_GUEST_TAG],
      description: `hacm-managed: ${uuid}`,
    });
    await expect(
      fixture.service.verifyForMutation('pve-01', 900, {
        operation: 'guest.power.stop',
      }),
    ).rejects.toBeInstanceOf(ProtectedGuestError);

    fixture.setDescription(`hacm-managed: ${managedGuestUuid('pve-02', 112)}`);
    await expect(
      fixture.service.verifyForMutation('pve-01', 112, {
        operation: 'guest.update',
      }),
    ).rejects.toBeInstanceOf(GuestIdentityError);

    fixture.setDescription(undefined);
    await expect(
      fixture.service.verifyForMutation('pve-01', 112, {
        operation: 'guest.update',
      }),
    ).rejects.toBeInstanceOf(GuestIdentityError);
    await expect(
      fixture.service.verifyForMutation('pve-01', 112, {
        operation: 'guest.stamp',
        requireManaged: false,
      }),
    ).resolves.toMatchObject({ vmid: 112 });

    fixture.setTags([MANAGED_GUEST_TAG]);
    fixture.setDescription(`hacm-managed: ${uuid}`);
    const protectedFixture = await createFixture({
      tags: [MANAGED_GUEST_TAG],
      description: `hacm-managed: ${uuid}`,
      protection: true,
      identityChecks: ['test -f /etc/os-release'],
    });
    await expect(
      protectedFixture.service.verifyForMutation('pve-01', 112, {
        operation: 'guest.power.stop',
        runIdentityChecks: false,
      }),
    ).rejects.toBeInstanceOf(GuestProtectionEnabledError);
    await expect(
      protectedFixture.service.verifyForMutation('pve-01', 112, {
        operation: 'guest.power.start',
        runIdentityChecks: false,
      }),
    ).resolves.toMatchObject({ vmid: 112 });
    await expect(
      protectedFixture.service.verifyForMutation('pve-01', 112, {
        operation: 'guest.stamp',
        runIdentityChecks: false,
      }),
    ).resolves.toMatchObject({ vmid: 112 });

    const checkedFixture = await createFixture({
      tags: [MANAGED_GUEST_TAG],
      description: `hacm-managed: ${uuid}`,
      status: 'stopped',
      identityChecks: ['test -f /etc/os-release'],
    });
    await expect(
      checkedFixture.service.verifyForMutation('pve-01', 112, {
        operation: 'guest.update',
      }),
    ).rejects.toBeInstanceOf(GuestStoppedIdentityError);
    await expect(
      checkedFixture.service.verifyForMutation('pve-01', 112, {
        operation: 'guest.update',
        runIdentityChecks: false,
      }),
    ).resolves.toMatchObject({ vmid: 112 });

    checkedFixture.setStatus('running');
    checkedFixture.setExecHandler(() => ({ exitCode: 2 }));
    await expect(
      checkedFixture.service.verifyForMutation('pve-01', 112, {
        operation: 'guest.update',
      }),
    ).rejects.toBeInstanceOf(GuestIdentityCheckError);
  });

  it('stamps guests idempotently and reports command failures', async () => {
    const fixture = await createFixture();
    const dryRun = await fixture.service.stampGuest('pve-01', 112, {
      dryRun: true,
    });
    expect(dryRun.changed).toBe(true);
    expect(fixture.calls).toHaveLength(0);

    const applied = await fixture.service.stampGuest('pve-01', 112);
    expect(applied.tags).toContain(MANAGED_GUEST_TAG);
    expect(fixture.calls[0]?.argv).toEqual([
      'pct',
      'set',
      '112',
      '--tags',
      MANAGED_GUEST_TAG,
      '--description',
      expect.stringContaining('hacm-managed:'),
    ]);
    expect(fixture.inventory.invalidate).toHaveBeenCalledWith('pve-01');

    fixture.setTags(applied.tags);
    fixture.setDescription(applied.description);
    await expect(
      fixture.service.stampGuest('pve-01', 112),
    ).resolves.toMatchObject({ changed: false });

    fixture.setExecHandler(() => ({
      exitCode: 255,
      stderr: 'permission denied',
    }));
    fixture.setTags([]);
    fixture.setDescription(undefined);
    await expect(fixture.service.stampGuest('pve-01', 112)).rejects.toThrow(
      'permission denied',
    );
    fixture.setExecHandler(() => ({ exitCode: 255 }));
    await expect(fixture.service.stampGuest('pve-01', 112)).rejects.toThrow(
      'exit code 255',
    );
  });

  it('executes power actions and waits for API tasks', async () => {
    const fixture = await createFixture();
    const logged: string[] = [];
    fixture.setPowerResult({
      upid: 'UPID:pve-01:0:0:0:start:112:0',
      source: 'api',
    });
    await expect(
      fixture.service.executePower('pve-01', 112, 'start', {
        log: async (message) => {
          logged.push(message);
        },
      }),
    ).resolves.toMatchObject({ source: 'api' });
    expect(fixture.waitForTask).toHaveBeenCalledWith(
      'UPID:pve-01:0:0:0:start:112:0',
      expect.objectContaining({ timeoutMs: 300_000 }),
    );
    expect(logged[0]).toContain("'start'");
    expect(fixture.inventory.invalidate).toHaveBeenCalledWith('pve-01');

    fixture.setPowerResult({ source: 'ssh' });
    const sshLogged: string[] = [];
    await fixture.service.executePower('pve-01', 112, 'stop', {
      log: async (message) => {
        sshLogged.push(message);
      },
    });
    expect(sshLogged[0]).toContain("'stop'");
    expect(sshLogged[0]).not.toContain('UPID');
    await expect(
      fixture.service.executePower('pve-01', 900, 'stop'),
    ).rejects.toBeInstanceOf(ProtectedGuestError);
  });

  it('verifies power state and waits for a transition', async () => {
    const fixture = await createFixture();
    fixture.setStatus('running');
    await expect(
      fixture.service.verifyPowerState('pve-01', 112, 'start'),
    ).resolves.toEqual({ status: 'running', expected: 'running' });
    await expect(
      fixture.service.verifyPowerState('pve-01', 112, 'stop'),
    ).rejects.toThrow("expected 'stopped'");

    await expect(
      fixture.service.waitForPowerState('pve-01', 112, 'stop', {
        timeoutMs: 5,
        intervalMs: 1,
      }),
    ).rejects.toThrow("expected 'stopped'");

    const controller = new AbortController();
    controller.abort(new Error('cancelled by fixture'));
    await expect(
      fixture.service.waitForPowerState('pve-01', 112, 'stop', {
        signal: controller.signal,
        timeoutMs: 5,
        intervalMs: 1,
      }),
    ).rejects.toThrow('cancelled by fixture');
  });

  it('runs checks for reports with a VMID hint and rejects without a guest', async () => {
    const fixture = await createFixture();
    await expect(
      fixture.service.runIdentityChecksForReport('pve-01', 112, []),
    ).resolves.toEqual([]);
    fixture.setExecHandler(() => ({ exitCode: 1 }));
    await expect(
      fixture.service.runIdentityChecksForReport('pve-01', 999, ['true']),
    ).rejects.toBeInstanceOf(GuestNotFoundError);
  });
});

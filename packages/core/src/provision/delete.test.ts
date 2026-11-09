import { describe, expect, it } from 'vitest';
import type { StepExecutionContext } from '../steps/types.js';
import { FakeTransport } from '../transport/fake.js';
import {
  createGuestDeleteSteps,
  guestDeleteState,
  planGuestDeletion,
  type GuestDeleteTarget,
} from './delete.js';

function target(overrides: Partial<GuestDeleteTarget> = {}): GuestDeleteTarget {
  return {
    hostId: 'pve-01',
    vmid: 112,
    type: 'lxc',
    name: 'example-lxc',
    status: 'running',
    protection: false,
    ...overrides,
  };
}

function logger() {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

function context(transport: FakeTransport): StepExecutionContext<undefined> {
  return {
    operationId: 'guest-delete-test',
    input: undefined,
    transport,
    logger: logger(),
    dryRun: false,
    signal: new AbortController().signal,
  };
}

function findStep(
  steps: ReturnType<typeof createGuestDeleteSteps>,
  fragment: string,
) {
  const step = steps.find((candidate) => candidate.name.includes(fragment));
  if (!step) throw new Error(`Missing step containing '${fragment}'`);
  return step;
}

describe('planGuestDeletion', () => {
  it('plans a plain running LXC deletion and warns about the missing backup', () => {
    const plan = planGuestDeletion(target());
    expect(plan.summary).toBe('Delete LXC 112 (example-lxc) on pve-01');
    expect(plan.blocked).toBe(false);
    expect(plan.destructive).toBe(true);
    expect(plan.changes.map((change) => change.id)).toEqual(['stop', 'delete']);
    expect(plan.commands).toEqual([
      ['pct', 'stop', '112'],
      ['pct', 'destroy', '112'],
    ]);
    expect(plan.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('No backup is taken')]),
    );
  });

  it('plans backup, unprotect, purge and VM-specific destroy options', () => {
    const plan = planGuestDeletion(
      target({
        type: 'vm',
        name: 'example-vm',
        protection: true,
        mounts: [
          { index: 0, host_path: '/data', guest_path: '/data' },
          { index: 1, host_path: '/skip', guest_path: '/skip', backup: false },
        ],
        backup_storage: 'backup-store',
      }),
      { backup: true, purge: true, unprotect: true },
    );
    expect(plan.changes.map((change) => change.id)).toEqual([
      'backup',
      'unprotect',
      'stop',
      'delete',
    ]);
    expect(plan.commands).toEqual([
      [
        'vzdump',
        '112',
        '--mode',
        'snapshot',
        '--compress',
        'zstd',
        '--storage',
        'backup-store',
      ],
      ['qm', 'set', '112', '--protection', '0'],
      ['qm', 'stop', '112'],
      [
        'qm',
        'destroy',
        '112',
        '--purge',
        '1',
        '--destroy-unreferenced-disks',
        '1',
      ],
    ]);
    expect(plan.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('bind-mounted mp data'),
        expect.stringContaining('Protection is lifted'),
        expect.stringContaining('Purge is enabled'),
      ]),
    );
    expect(plan.warnings.some((warning) => warning.includes('/skip'))).toBe(
      false,
    );
  });

  it('uses an explicit backup storage and skips stop for a stopped guest', () => {
    const plan = planGuestDeletion(target({ status: 'stopped' }), {
      backup: true,
      backupStorage: 'explicit-store',
    });
    expect(plan.changes.map((change) => change.id)).toEqual([
      'backup',
      'delete',
    ]);
    expect(plan.commands[0]).toEqual([
      'vzdump',
      '112',
      '--mode',
      'snapshot',
      '--compress',
      'zstd',
      '--storage',
      'explicit-store',
    ]);
    expect(plan.commands).not.toContainEqual(['pct', 'stop', '112']);
  });

  it('blocks deletion of a protected guest without explicit unprotect', () => {
    const plan = planGuestDeletion(target({ protection: true }));
    expect(plan.blocked).toBe(true);
    expect(plan.blockReason).toContain('is protected');
    expect(plan.changes).toEqual([]);
    expect(plan.commands).toEqual([]);
    expect(plan.destructive).toBe(true);
  });

  it('fingerprints the target and options', () => {
    expect(guestDeleteState(target(), { purge: true })).toEqual({
      target: target(),
      options: { purge: true },
    });
  });
});

describe('createGuestDeleteSteps', () => {
  const present = /^test -f /;

  it('backs up, unprotects, stops and deletes a VM', async () => {
    const guest = target({ type: 'vm', protection: true });
    const steps = createGuestDeleteSteps(guest, {
      backup: true,
      unprotect: true,
      purge: true,
    });
    expect(steps.map((step) => step.name)).toEqual([
      'back up vm 112 before deletion',
      'lift protection on vm 112',
      'stop vm 112 before deletion',
      'delete vm 112',
    ]);

    const backup = findStep(steps, 'back up');
    expect(
      await backup.check(
        context(new FakeTransport().onExec(present, { exitCode: 1 })),
      ),
    ).toEqual({ status: 'satisfied', detail: { missing: true } });
    expect(
      await backup.check(
        context(new FakeTransport().onExec(present, { exitCode: 0 })),
      ),
    ).toEqual({ status: 'required' });
    const backupTransport = new FakeTransport().onExec(/^vzdump /, {
      stdout: 'backup done',
    });
    expect(await backup.apply(context(backupTransport))).toEqual({
      backup: true,
    });
    expect(backupTransport.execArgv[0]).toEqual([
      'vzdump',
      '112',
      '--mode',
      'snapshot',
      '--compress',
      'zstd',
    ]);
    await expect(
      backup.verify(
        context(new FakeTransport().onExec(present, { exitCode: 1 })),
      ),
    ).rejects.toThrow('disappeared before its backup');
    await expect(
      backup.verify(
        context(new FakeTransport().onExec(present, { exitCode: 0 })),
      ),
    ).resolves.toEqual({ backup: true });

    const unprotect = findStep(steps, 'lift protection');
    expect(
      await unprotect.check(
        context(
          new FakeTransport()
            .onExec(present, { exitCode: 0 })
            .onExec(/^qm config 112/, { stdout: 'protection: 1' }),
        ),
      ),
    ).toEqual({ status: 'required' });
    expect(
      await unprotect.check(
        context(
          new FakeTransport()
            .onExec(present, { exitCode: 0 })
            .onExec(/^qm config 112/, { stdout: 'cores: 2' }),
        ),
      ),
    ).toEqual({ status: 'satisfied', detail: { protection: false } });
    expect(
      await unprotect.check(
        context(new FakeTransport().onExec(present, { exitCode: 1 })),
      ),
    ).toEqual({ status: 'satisfied', detail: { missing: true } });
    expect(
      await unprotect.apply(
        context(new FakeTransport().onExec(/^qm set 112 /, { stdout: 'ok' })),
      ),
    ).toEqual({ protection: false });
    await expect(
      unprotect.verify(
        context(
          new FakeTransport().onExec(/^qm config 112/, {
            stdout: 'protection: true',
          }),
        ),
      ),
    ).rejects.toThrow('still protected');
    await expect(
      unprotect.verify(
        context(
          new FakeTransport().onExec(/^qm config 112/, { stdout: 'cores: 2' }),
        ),
      ),
    ).resolves.toEqual({ protection: false });

    const stop = findStep(steps, 'stop vm');
    expect(
      await stop.check(
        context(
          new FakeTransport()
            .onExec(present, { exitCode: 0 })
            .onExec('qm status 112', { stdout: 'status: running' }),
        ),
      ),
    ).toEqual({ status: 'required', detail: { status: 'running' } });
    expect(
      await stop.check(
        context(
          new FakeTransport()
            .onExec(present, { exitCode: 0 })
            .onExec('qm status 112', { stdout: 'status: stopped' }),
        ),
      ),
    ).toEqual({ status: 'satisfied', detail: { status: 'stopped' } });
    expect(
      await stop.check(
        context(new FakeTransport().onExec(present, { exitCode: 1 })),
      ),
    ).toEqual({ status: 'satisfied', detail: { missing: true } });
    expect(
      await stop.apply(
        context(new FakeTransport().onExec(/^qm stop 112/, { stdout: 'ok' })),
      ),
    ).toEqual({ status: 'stopped' });
    await expect(
      stop.verify(
        context(
          new FakeTransport().onExec('qm status 112', {
            stdout: 'status: running',
          }),
        ),
      ),
    ).rejects.toThrow("is 'running' after stop");
    await expect(
      stop.verify(
        context(
          new FakeTransport().onExec('qm status 112', {
            stdout: 'status: stopped',
          }),
        ),
      ),
    ).resolves.toEqual({ status: 'stopped' });
    await expect(
      stop.verify(
        context(
          new FakeTransport().onExec('qm status 112', {
            exitCode: 1,
            stderr: 'not found',
          }),
        ),
      ),
    ).resolves.toEqual({ status: 'missing' });

    const destroy = findStep(steps, 'delete vm');
    expect(
      await destroy.check(
        context(new FakeTransport().onExec(present, { exitCode: 1 })),
      ),
    ).toEqual({ status: 'satisfied', detail: { missing: true } });
    expect(
      await destroy.check(
        context(new FakeTransport().onExec(present, { exitCode: 0 })),
      ),
    ).toEqual({ status: 'required' });
    const destroyTransport = new FakeTransport().onExec(/^qm destroy /, {
      stdout: 'deleted',
    });
    expect(await destroy.apply(context(destroyTransport))).toEqual({
      deleted: true,
    });
    expect(destroyTransport.execArgv[0]).toEqual([
      'qm',
      'destroy',
      '112',
      '--purge',
      '1',
      '--destroy-unreferenced-disks',
      '1',
    ]);
    await expect(
      destroy.verify(
        context(new FakeTransport().onExec(present, { exitCode: 0 })),
      ),
    ).rejects.toThrow('still has a configuration file');
    await expect(
      destroy.verify(
        context(new FakeTransport().onExec(present, { exitCode: 1 })),
      ),
    ).resolves.toEqual({ deleted: true });
  });

  it('omits backup and unprotect steps when they are not requested', () => {
    const steps = createGuestDeleteSteps(target());
    expect(steps.map((step) => step.name)).toEqual([
      'stop lxc 112 before deletion',
      'delete lxc 112',
    ]);
  });

  it('reports command failures with stderr or the exit code', async () => {
    const steps = createGuestDeleteSteps(target(), {
      backup: true,
      unprotect: true,
    });
    const backup = findStep(steps, 'back up');
    for (const stderr of ['', 'storage full']) {
      await expect(
        backup.apply(
          context(
            new FakeTransport().onExec(/^vzdump /, { exitCode: 1, stderr }),
          ),
        ),
      ).rejects.toThrow(stderr === '' ? 'exit code 1' : 'storage full');
    }

    const destroy = findStep(steps, 'delete');
    for (const stderr of ['', 'cannot destroy']) {
      await expect(
        destroy.apply(
          context(
            new FakeTransport().onExec(/^pct destroy /, {
              exitCode: 1,
              stderr,
            }),
          ),
        ),
      ).rejects.toThrow(stderr === '' ? 'exit code 1' : 'cannot destroy');
    }

    const stop = findStep(steps, 'stop');
    await expect(
      stop.verify(
        context(
          new FakeTransport().onExec('pct status 112', {
            stdout: 'status: paused',
          }),
        ),
      ),
    ).rejects.toThrow("is 'paused' after stop");
  });
});

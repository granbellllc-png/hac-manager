import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JobRow, InsertJobRow } from '../db/schema.js';
import { createDatabase } from '../db/connection.js';
import { createSqliteRepositories } from '../db/repositories/sqlite.js';
import type { DatabaseRepositories } from '../db/repositories/types.js';
import { FakeTransport } from '@hacm/core';
import type { DurableJobQueue } from '../jobs/queue.js';
import type { JobExecutionContext } from '../jobs/types.js';
import {
  StorageGuestNotFoundError,
  StorageInvariantJobError,
  StorageInvariantService,
  type StorageInvariantServiceOptions,
} from './service.js';

const hostPath = '/opt/server-data/pve-01/adguard/opt';
const rootfsMountPath = '/var/lib/lxc/112/rootfs';
const guestOptPath = `${rootfsMountPath}/opt`;
const timestamp = '2026-11-10T120000Z';
const displacedPath = `${guestOptPath}.migrated-${timestamp}`;
const mp0Value = `${hostPath},backup=1,mp=/opt`;
const rootfsBackupPath = `/opt/server-data/.backups/pve-01/112/${timestamp}-rootfs-data.tar.gz`;
const createdAt = new Date('2026-11-10T12:00:00.000Z');
const pid = 4242;

const config = [
  'hostname: adguard',
  'cores: 2',
  'rootfs: local-lvm:vm-112-disk-0,size=10G',
  `mp0: ${mp0Value}`,
].join('\n');

const baseConfig = [
  'hostname: adguard',
  'cores: 2',
  'memory: 1024',
  'rootfs: local-lvm:vm-112-disk-0,size=10G',
].join('\n');

const deploymentYaml = `schema_version: 1
id: 112
name: adguard
type: lxc
unprivileged: true
cpu: 2
ram: 1024
disks:
  - name: rootfs
    storage: local-lvm
    size_gb: 10
network:
  - index: 0
    name: eth0
    bridge: vmbr0
mounts:
  - index: 0
    host_path: ${hostPath}
    guest_path: /opt
    backup: true
    permissions: minimal
`;

async function dataDirFixture(): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), 'hacm-storage-service-'));
  const hostDir = join(dataDir, 'hosts', 'pve-01');
  const guestDir = join(hostDir, '112-adguard');
  await mkdir(guestDir, { recursive: true });
  await writeFile(
    join(hostDir, 'host.yaml'),
    `schema_version: 1
id: pve-01
name: Proxmox Node 1
type: proxmox
index: 1
connection:
  ssh:
    host: 192.0.2.10
    port: 22
    username: root
`,
    'utf8',
  );
  await writeFile(join(guestDir, 'deployment.yaml'), deploymentYaml, 'utf8');
  return dataDir;
}

function repoFixture(): {
  handle: ReturnType<typeof createDatabase>;
  repos: DatabaseRepositories;
} {
  const handle = createDatabase({ path: ':memory:' });
  return { handle, repos: createSqliteRepositories(handle.db) };
}

function queueStub(): {
  queue: Pick<DurableJobQueue, 'enqueue' | 'registerHandler'>;
  enqueue: ReturnType<typeof vi.fn>;
  registerHandler: ReturnType<typeof vi.fn>;
} {
  const enqueue = vi.fn(async () => jobRow());
  const registerHandler = vi.fn();
  return {
    queue: { enqueue, registerHandler } as unknown as Pick<
      DurableJobQueue,
      'enqueue' | 'registerHandler'
    >,
    enqueue,
    registerHandler,
  };
}

function jobRow(input: Partial<InsertJobRow> = {}): JobRow {
  const base: JobRow = {
    id: 'job-1',
    hostId: 'pve-01',
    vmid: 112,
    lane: 'guest',
    type: 'guest.storage.invariant',
    reason: 'manual',
    status: 'queued',
    priority: 0,
    payloadJson: null,
    triggeredBy: null,
    dependsOnJobId: null,
    timeoutMs: null,
    cancelRequestedAt: null,
    error: null,
    createdAt,
    startedAt: null,
    finishedAt: null,
  };
  return { ...base, ...input } as JobRow;
}

function contextFor(
  payload: unknown,
  prompt: (request: unknown) => Promise<unknown> = async () => ({}),
): {
  context: JobExecutionContext;
  logs: { stream: string; text: string }[];
  promptSpy: ReturnType<typeof vi.fn>;
} {
  const logs: { stream: string; text: string }[] = [];
  const promptSpy = vi.fn(prompt);
  return {
    logs,
    promptSpy,
    context: {
      job: jobRow(),
      payload,
      signal: new AbortController().signal,
      log: async (stream, text) => {
        logs.push({ stream, text });
      },
      prompt: promptSpy as JobExecutionContext['prompt'],
    },
  };
}

function summary(
  exists: boolean,
  files: number,
  bytes: number,
  newest?: string,
): string {
  if (!exists) return 'exists=0\nfiles=0\nbytes=0\n';
  return `exists=1\nfiles=${files}\nbytes=${bytes}\nnewest=${newest ?? ''}\n`;
}

function detection(
  transport: FakeTransport,
  options: {
    readonly mounted?: boolean;
    readonly host?: string;
    readonly rootfs?: string;
    readonly daemons?: string;
    readonly probe?: 'bind' | 'visible';
  } = {},
): FakeTransport {
  return transport
    .onExec('pct config 112', { stdout: config }, { once: true })
    .onExec('pct status 112', { stdout: 'status: running' }, { once: true })
    .onExec('lxc-info -n 112 -p -H', { stdout: `${pid}\n` }, { once: true })
    .onExec(
      `bash -s -- ${hostPath}`,
      {
        stdout: options.host ?? summary(true, 2, 512, '1762665600'),
      },
      { once: true },
    )
    .onExec(
      `nsenter -t ${pid} -m -- bash -s -- /opt /run/hacm-rootfs-probe`,
      {
        stdout: `probe=${options.probe ?? 'bind'}\n${
          options.rootfs ?? summary(true, 4, 900, '1762752000')
        }`,
      },
      { once: true },
    )
    .onExec(
      `nsenter -t ${pid} -m -- mountpoint -q /opt`,
      { exitCode: options.mounted === false ? 1 : 0 },
      { once: true },
    )
    .onExec(
      `bash -s -- /opt 112 dockerd containerd postgres postmaster`,
      { stdout: options.daemons ?? '' },
      { once: true },
    );
}

function sequence(
  transport: FakeTransport,
  matcher: string | RegExp,
  responses: readonly {
    readonly exitCode?: number;
    readonly stdout?: string;
    readonly stderr?: string;
  }[],
): FakeTransport {
  for (let index = responses.length - 1; index >= 0; index--) {
    transport.onExec(matcher, responses[index]!, { once: true });
  }
  return transport;
}

function okTransport(): FakeTransport {
  return detection(new FakeTransport(), {
    mounted: true,
    probe: 'visible',
    host: summary(true, 1, 10, '1762752000'),
    rootfs: summary(false, 0, 0),
  });
}

function serviceFixture(dataDir: string): {
  service: StorageInvariantService;
  repos: DatabaseRepositories;
  handle: ReturnType<typeof createDatabase>;
  queue: ReturnType<typeof queueStub>;
  getRouter: ReturnType<typeof vi.fn>;
} {
  const { handle, repos } = repoFixture();
  const queue = queueStub();
  const getRouter = vi.fn();
  const service = new StorageInvariantService({
    repos,
    queue: queue.queue,
    hostRegistry: { dataDir },
    connections: {
      getRouter,
    } as unknown as StorageInvariantServiceOptions['connections'],
    now: () => createdAt,
  });
  return { service, repos, handle, queue, getRouter };
}

describe('StorageInvariantService', () => {
  it('enqueues a check job and validates the guest exists', async () => {
    const dataDir = await dataDirFixture();
    const { service, handle, queue } = serviceFixture(dataDir);
    try {
      const job = await service.enqueueCheck({
        hostId: 'pve-01',
        vmid: 112,
        triggeredBy: 'user-1',
      });
      expect(job.type).toBe('guest.storage.invariant');
      expect(job.reason).toBe('manual');
      expect(queue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          hostId: 'pve-01',
          vmid: 112,
          priority: 'low',
          triggeredBy: 'user-1',
          payload: { vmid: 112 },
        }),
      );
      await service.enqueueCheck({ hostId: 'pve-01', vmid: 112 });
      expect(queue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ payload: { vmid: 112 } }),
      );
      expect(
        (queue.enqueue.mock.calls[1]![0] as Record<string, unknown>)
          .triggeredBy,
      ).toBeUndefined();
      await expect(
        service.enqueueCheck({ hostId: 'pve-01', vmid: 999 }),
      ).rejects.toBeInstanceOf(StorageGuestNotFoundError);
      await expect(
        service.enqueueCheck({ hostId: 'missing', vmid: 112 }),
      ).rejects.toBeInstanceOf(StorageGuestNotFoundError);
    } finally {
      handle.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('enqueues a resolution job only when a resolution is provided', async () => {
    const dataDir = await dataDirFixture();
    const { service, handle, queue } = serviceFixture(dataDir);
    try {
      await expect(
        service.enqueueResolution({ hostId: 'pve-01', vmid: 112 }),
      ).rejects.toBeInstanceOf(StorageInvariantJobError);
      await service.enqueueResolution({
        hostId: 'pve-01',
        vmid: 112,
        resolution: 'keep-host-data',
        triggeredBy: 'user-1',
      });
      expect(queue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'conflict_resolution',
          priority: 'high',
          triggeredBy: 'user-1',
          payload: { vmid: 112, resolution: 'keep-host-data' },
        }),
      );
      await expect(
        service.enqueueResolution({
          hostId: 'pve-01',
          vmid: 999,
          resolution: 'keep-host-data',
        }),
      ).rejects.toBeInstanceOf(StorageGuestNotFoundError);
    } finally {
      handle.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('registers the queue handler', async () => {
    const dataDir = '/tmp/unused';
    const { service, handle, queue } = serviceFixture(dataDir);
    service.registerQueueHandler();
    expect(queue.registerHandler).toHaveBeenCalledWith(
      'guest.storage.invariant',
      expect.any(Function),
    );
    const handler = queue.registerHandler.mock.calls[0]![1] as (
      context: JobExecutionContext,
    ) => Promise<void>;
    await expect(handler(contextFor(undefined).context)).rejects.toBeInstanceOf(
      StorageInvariantJobError,
    );
    handle.close();
  });

  it('inspects a guest without persisting anything', async () => {
    const dataDir = await dataDirFixture();
    const { service, handle, getRouter } = serviceFixture(dataDir);
    getRouter.mockResolvedValue(okTransport());
    try {
      const report = await service.inspect('pve-01', 112);
      expect(report.status).toBe('ok');
      expect(report.hostPath).toBe(hostPath);
      await expect(service.inspect('pve-01', 999)).rejects.toBeInstanceOf(
        StorageGuestNotFoundError,
      );
    } finally {
      handle.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('runs an ok check job and audits the read-only result', async () => {
    const dataDir = await dataDirFixture();
    const { service, repos, handle, getRouter } = serviceFixture(dataDir);
    getRouter.mockResolvedValue(okTransport());
    try {
      const { context, logs } = contextFor({ vmid: 112 });
      await service.executeJob(context);
      expect(logs.map((line) => line.text).join('\n')).toContain(
        'Storage invariant status: ok',
      );
      expect(logs.map((line) => line.text).join('\n')).toContain(
        'Warning: The raw rootfs probe could not bind-mount',
      );
      const audit = await repos.auditLogs.search({ hostId: 'pve-01' });
      expect(audit.items).toHaveLength(1);
      expect(audit.items[0]).toMatchObject({
        action: 'guest.storage.check',
        reason: 'conflict_resolution',
        vmid: 112,
      });
    } finally {
      handle.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects malformed payloads and unsupported prompt answers', async () => {
    const dataDir = await dataDirFixture();
    const { service, handle, getRouter } = serviceFixture(dataDir);
    getRouter.mockResolvedValue(
      detection(new FakeTransport(), { mounted: false }),
    );
    try {
      const malformed = [undefined, { vmid: 0 }, { vmid: 'x' }, { vmid: 1.5 }];
      for (const payload of malformed) {
        await expect(
          service.executeJob(contextFor(payload).context),
        ).rejects.toBeInstanceOf(StorageInvariantJobError);
      }

      const missingChoice = contextFor({ vmid: 112 });
      await expect(
        service.executeJob(missingChoice.context),
      ).rejects.toBeInstanceOf(StorageInvariantJobError);
      expect(missingChoice.promptSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'choice',
          options: ['Keep Host Data', 'Migrate Rootfs to Host'],
          payload: expect.objectContaining({
            status: 'split-brain',
            hostPath,
          }),
        }),
      );

      getRouter.mockResolvedValue(
        detection(new FakeTransport(), { mounted: false }),
      );
      const badChoice = contextFor({ vmid: 112 }, async () => ({
        choice: 'Delete Everything',
      }));
      await expect(
        service.executeJob(badChoice.context),
      ).rejects.toBeInstanceOf(StorageInvariantJobError);

      getRouter.mockResolvedValue(
        detection(new FakeTransport(), { mounted: false }),
      );
      const nullChoice = contextFor({ vmid: 112 }, async () => null);
      await expect(
        service.executeJob(nullChoice.context),
      ).rejects.toBeInstanceOf(StorageInvariantJobError);
    } finally {
      handle.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('keeps host data after prompting and archives the rootfs copy', async () => {
    const dataDir = await dataDirFixture();
    const { service, repos, handle, getRouter } = serviceFixture(dataDir);
    const transport = detection(new FakeTransport(), { mounted: false });
    sequence(transport, `stat -c %u:%g:%a ${hostPath}`, [
      { stdout: '100000:100000:750' },
      { stdout: '100000:100000:750' },
      { stdout: '100000:100000:750' },
    ]);
    sequence(transport, 'pct status 112', [
      { stdout: 'status: running' },
      { stdout: 'status: running' },
      { stdout: 'status: stopped' },
      { stdout: 'status: stopped' },
      { stdout: 'status: stopped' },
      { stdout: 'status: stopped' },
      { stdout: 'status: stopped' },
      { stdout: 'status: running' },
      { stdout: 'status: running' },
    ]);
    sequence(transport, 'pct config 112', [
      { stdout: baseConfig },
      { stdout: baseConfig },
      { stdout: `${baseConfig}\nmp0: ${mp0Value}` },
      { stdout: `${baseConfig}\nmp0: ${mp0Value}` },
    ]);
    sequence(transport, `mountpoint -q ${rootfsMountPath}`, [
      { exitCode: 1 },
      { exitCode: 1 },
      {},
      {},
      {},
      { exitCode: 1 },
    ]);
    sequence(transport, `test -s ${rootfsBackupPath}`, [
      { exitCode: 1 },
      { exitCode: 1 },
      {},
    ]);
    sequence(transport, `test -e ${guestOptPath}`, [
      {},
      {},
      {},
      {},
      {},
      { exitCode: 1 },
    ]);
    sequence(transport, `test -e ${displacedPath}`, [
      { exitCode: 1 },
      { exitCode: 1 },
      {},
    ]);
    transport.onExec('pct shutdown 112 --timeout 120', {});
    transport.onExec('pct mount 112', {});
    transport.onExec(
      `install -d -m 0700 /opt/server-data/.backups/pve-01/112`,
      {},
    );
    transport.onExec(
      [
        'tar',
        '--xattrs',
        '--acls',
        '--numeric-owner',
        '-cpzf',
        rootfsBackupPath,
        '-C',
        guestOptPath,
        '.',
      ].join(' '),
      {},
    );
    transport.onExec(`mv ${guestOptPath} ${displacedPath}`, {});
    transport.onExec('pct unmount 112', {});
    transport.onExec(`pct set 112 --mp0 ${mp0Value}`, {});
    transport.onExec('pct start 112', {});
    getRouter.mockResolvedValue(transport);
    await repos.jobs.create({
      id: 'job-1',
      hostId: 'pve-01',
      vmid: 112,
      lane: 'guest',
      type: 'guest.storage.invariant',
      reason: 'conflict_resolution',
      status: 'running',
      priority: 0,
      createdAt,
    });

    try {
      const { context, promptSpy } = contextFor({ vmid: 112 }, async () => ({
        choice: 'Keep Host Data',
      }));
      await service.executeJob(context);
      expect(promptSpy).toHaveBeenCalledTimes(1);
      const audit = await repos.auditLogs.search({ hostId: 'pve-01' });
      expect(audit.items[0]).toMatchObject({
        action: 'guest.storage.resolve',
        reason: 'conflict_resolution',
      });
      expect(
        transport.execArgv.some(
          (argv) => argv[0] === 'mv' && argv[2] === displacedPath,
        ),
      ).toBe(true);
      expect(transport.execArgv.some((argv) => argv[0] === 'rm')).toBe(false);
    } finally {
      handle.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('uses an explicit resolution payload without prompting', async () => {
    const dataDir = await dataDirFixture();
    const { service, repos, handle, getRouter } = serviceFixture(dataDir);
    const transport = detection(new FakeTransport(), { mounted: false });
    getRouter.mockResolvedValue(transport);
    try {
      const { context, promptSpy } = contextFor({
        vmid: 112,
        resolution: 'migrate-rootfs-to-host',
      });
      await expect(service.executeJob(context)).rejects.toThrow();
      expect(promptSpy).not.toHaveBeenCalled();
      const audit = await repos.auditLogs.search({ hostId: 'pve-01' });
      expect(audit.items).toHaveLength(0);
    } finally {
      handle.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

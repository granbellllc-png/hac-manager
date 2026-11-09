import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeTransport, type GuestDeployment } from '@hacm/core';
import { buildApp } from '../../app.js';
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
} from '../../auth/session.js';
import { loadConfig } from '../../config.js';
import { createDatabase, createSqliteRepositories } from '../../db/index.js';
import type { LiveGuestDetail } from '../../inventory/types.js';
import { DurableJobQueue } from '../../jobs/queue.js';
import { PlanService } from '../../plans/service.js';

const tempDirs: string[] = [];

function parseCookie(
  header: string | string[] | undefined,
  name: string,
): string | undefined {
  if (!header) return undefined;
  for (const value of Array.isArray(header) ? header : [header]) {
    const match = value.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    if (match) return match[1];
  }
  return undefined;
}

function session(headers: Record<string, unknown>) {
  const setCookie = headers['set-cookie'] as string | string[] | undefined;
  const sessionId = parseCookie(setCookie, SESSION_COOKIE_NAME)!;
  const csrf = parseCookie(setCookie, CSRF_COOKIE_NAME)!;
  return {
    cookie: `${SESSION_COOKIE_NAME}=${sessionId}; ${CSRF_COOKIE_NAME}=${csrf}`,
    csrf,
  };
}

function guest(hostId: string, vmid: number, ram = 2_048): LiveGuestDetail {
  const canonicalConfig: GuestDeployment = {
    id: vmid,
    name: `guest-${vmid}`,
    type: 'lxc',
    cpu: 2,
    ram,
    disks: [],
    network: [],
  };
  return {
    summary: {
      hostId,
      vmid,
      name: canonicalConfig.name,
      type: 'lxc',
      status: 'running',
      node: hostId,
    },
    rawConfig: `hostname: ${canonicalConfig.name}`,
    canonicalConfig,
    source: 'api',
  };
}

async function createFixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'hacm-plans-api-data-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'hacm-plans-api-state-'));
  tempDirs.push(dataDir, stateDir);
  for (const [id, index] of [
    ['pve-01', 1],
    ['pve-02', 2],
  ] as const) {
    const dir = join(dataDir, 'hosts', id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'host.yaml'),
      `schema_version: 1
id: ${id}
name: ${id}
type: proxmox
index: ${index}
connection:
  ssh:
    host: 192.0.2.${index}
`,
      'utf8',
    );
  }
  const config = loadConfig({
    HACM_DATA_DIR: dataDir,
    HACM_STATE_DIR: stateDir,
    HACM_COOKIE_SECURE: 'false',
    HACM_SESSION_SECRET: 'l'.repeat(32),
  });
  const guestDir = join(dataDir, 'hosts', 'pve-01', '114-new-lxc');
  await mkdir(guestDir, { recursive: true });
  await writeFile(
    join(guestDir, 'deployment.yaml'),
    `schema_version: 1
id: 114
name: new-lxc
type: lxc
cpu: 1
ram: 512
disks:
  - name: rootfs
    storage: local-lvm
    size_gb: 8
network:
  - index: 0
    bridge: vmbr0
installation:
  type: template
  template: local:vztmpl/debian-12-standard.tar.zst
`,
    'utf8',
  );
  const updateDir = join(dataDir, 'hosts', 'pve-01', '116-update-lxc');
  await mkdir(updateDir, { recursive: true });
  await writeFile(
    join(updateDir, 'deployment.yaml'),
    `schema_version: 1
id: 116
name: update-lxc
type: lxc
cpu: 4
ram: 2048
disks: []
network: []
`,
    'utf8',
  );
  const vmDir = join(dataDir, 'hosts', 'pve-01', '214-new-vm');
  await mkdir(vmDir, { recursive: true });
  await writeFile(
    join(vmDir, 'deployment.yaml'),
    `schema_version: 1
id: 214
name: new-vm
type: vm
cpu: 2
ram: 1024
disks: []
network: []
installation:
  type: clone
  template_id: 9000
`,
    'utf8',
  );
  const createTransport = new FakeTransport()
    .onExec('test -f /etc/pve/local/qemu-server/114.conf', { exitCode: 1 })
    .onExec('test -f /etc/pve/local/lxc/114.conf', { exitCode: 1 })
    .onExec('test -f /etc/pve/local/qemu-server/214.conf', { exitCode: 1 })
    .onExec('test -f /etc/pve/local/lxc/214.conf', { exitCode: 1 })
    .onExec('test -f /etc/pve/local/qemu-server/116.conf', { exitCode: 1 })
    .onExec('test -f /etc/pve/local/lxc/116.conf', { exitCode: 1 });
  const handle = createDatabase({ path: ':memory:' });
  const repos = createSqliteRepositories(handle.db);
  const queue = new DurableJobQueue(repos);
  const live = new Map<string, LiveGuestDetail>([
    ['pve-01:112', guest('pve-01', 112)],
    ['pve-01:113', guest('pve-01', 113)],
    ['pve-01:116', guest('pve-01', 116)],
    ['pve-02:212', guest('pve-02', 212)],
  ]);
  const planService = new PlanService(
    repos,
    queue,
    {
      async getGuestLiveConfig(hostId: string, vmid: number) {
        const detail = live.get(`${hostId}:${vmid}`);
        if (!detail) throw new Error(`Guest '${hostId}/${vmid}' not found`);
        return detail;
      },
    },
    { dataDir },
    {
      async requireSnapshot(hostId: string, vmid: number) {
        const detail = live.get(`${hostId}:${vmid}`);
        if (!detail) throw new Error(`Guest '${hostId}/${vmid}' not found`);
        return {
          hostId,
          vmid,
          type: 'lxc',
          summary: detail.summary,
          deployment: detail.canonicalConfig,
          status: detail.summary.status,
        };
      },
      verifyForMutation: async (hostId: string, vmid: number) => {
        const detail = live.get(`${hostId}:${vmid}`);
        if (!detail) throw new Error(`Guest '${hostId}/${vmid}' not found`);
        return {
          hostId,
          vmid,
          type: 'lxc',
          summary: detail.summary,
          deployment: detail.canonicalConfig,
          status: detail.summary.status,
        };
      },
      async executePower() {
        return { source: 'ssh' };
      },
      async waitForPowerState() {
        return { status: 'running', expected: 'running' };
      },
    } as never,
    {
      async getRouter() {
        return createTransport as never;
      },
      secretManager: undefined as never,
    },
  );
  const app = await buildApp({
    config,
    repositories: repos,
    jobQueue: queue,
    planService,
  });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { username: 'admin', password: 'Password123!' },
  });
  const admin = session(setup.headers);
  for (const [username, role] of [
    ['operator', 'operator'],
    ['viewer', 'viewer'],
  ] as const) {
    await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: {
        cookie: admin.cookie,
        [CSRF_HEADER_NAME]: admin.csrf,
      },
      payload: {
        username,
        password: `Password-${username}-123!`,
        role,
        grantedHosts: ['pve-01'],
      },
    });
  }
  const operatorLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'operator', password: 'Password-operator-123!' },
  });
  const viewerLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'viewer', password: 'Password-viewer-123!' },
  });
  await queue.start();
  return {
    app,
    handle,
    queue,
    live,
    admin,
    operator: session(operatorLogin.headers),
    viewer: session(viewerLogin.headers),
  };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('plans API', () => {
  it('creates, scopes, views, applies, and rejects stale plans', async () => {
    const fixture = await createFixture();
    try {
      const create = await fixture.app.inject({
        method: 'POST',
        url: '/api/plans/guest-import',
        headers: {
          cookie: fixture.operator.cookie,
          [CSRF_HEADER_NAME]: fixture.operator.csrf,
        },
        payload: { hostId: 'pve-01', vmid: 112 },
      });
      expect(create.statusCode).toBe(201);
      const plan = create.json() as { id: string };

      const viewerApply = await fixture.app.inject({
        method: 'POST',
        url: `/api/plans/${plan.id}/apply`,
        headers: {
          cookie: fixture.viewer.cookie,
          [CSRF_HEADER_NAME]: fixture.viewer.csrf,
        },
        payload: {},
      });
      expect(viewerApply.statusCode).toBe(403);

      const apply = await fixture.app.inject({
        method: 'POST',
        url: `/api/plans/${plan.id}/apply`,
        headers: {
          cookie: fixture.operator.cookie,
          [CSRF_HEADER_NAME]: fixture.operator.csrf,
        },
        payload: {},
      });
      expect(apply.statusCode).toBe(202);
      const jobId = (apply.json() as { job: { id: string } }).job.id;
      await expect(fixture.queue.waitForJob(jobId)).resolves.toMatchObject({
        status: 'completed',
      });
      const viewed = await fixture.app.inject({
        method: 'GET',
        url: `/api/plans/${plan.id}`,
        headers: { cookie: fixture.operator.cookie },
      });
      expect(viewed.statusCode).toBe(200);
      expect(viewed.json()).toMatchObject({ status: 'applied' });

      const adminCreate = await fixture.app.inject({
        method: 'POST',
        url: '/api/plans/guest-import',
        headers: {
          cookie: fixture.admin.cookie,
          [CSRF_HEADER_NAME]: fixture.admin.csrf,
        },
        payload: { hostId: 'pve-02', vmid: 212 },
      });
      expect(adminCreate.statusCode).toBe(201);
      const denied = await fixture.app.inject({
        method: 'GET',
        url: `/api/plans/${(adminCreate.json() as { id: string }).id}`,
        headers: { cookie: fixture.operator.cookie },
      });
      expect(denied.statusCode).toBe(403);
      const list = await fixture.app.inject({
        method: 'GET',
        url: '/api/plans',
        headers: { cookie: fixture.operator.cookie },
      });
      expect(list.statusCode).toBe(200);
      expect(
        (list.json() as { plans: Array<{ target: { hostId: string } }> }).plans,
      ).toEqual([
        expect.objectContaining({
          target: { hostId: 'pve-01', vmid: 112, resourceType: 'guest' },
        }),
      ]);

      const staleCreate = await fixture.app.inject({
        method: 'POST',
        url: '/api/plans/guest-import',
        headers: {
          cookie: fixture.operator.cookie,
          [CSRF_HEADER_NAME]: fixture.operator.csrf,
        },
        payload: { hostId: 'pve-01', vmid: 113 },
      });
      expect(staleCreate.statusCode).toBe(201);
      fixture.live.set('pve-01:113', guest('pve-01', 113, 4_096));
      const staleApply = await fixture.app.inject({
        method: 'POST',
        url: `/api/plans/${(staleCreate.json() as { id: string }).id}/apply`,
        headers: {
          cookie: fixture.operator.cookie,
          [CSRF_HEADER_NAME]: fixture.operator.csrf,
        },
        payload: {},
      });
      expect(staleApply.statusCode).toBe(409);
      expect(staleApply.json().message).toContain('stale');
    } finally {
      await fixture.app.close();
      fixture.handle.close();
    }
  });

  it('restricts LXC creation plans to administrators and granted hosts', async () => {
    const fixture = await createFixture();
    try {
      const denied = await fixture.app.inject({
        method: 'POST',
        url: '/api/plans/lxc-create',
        headers: {
          cookie: fixture.operator.cookie,
          [CSRF_HEADER_NAME]: fixture.operator.csrf,
        },
        payload: { hostId: 'pve-01', vmid: 114 },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().message).toContain('administrators');

      const created = await fixture.app.inject({
        method: 'POST',
        url: '/api/plans/lxc-create',
        headers: {
          cookie: fixture.admin.cookie,
          [CSRF_HEADER_NAME]: fixture.admin.csrf,
        },
        payload: { hostId: 'pve-01', vmid: 114 },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({
        operation: 'guest.create',
        target: { hostId: 'pve-01', vmid: 114, resourceType: 'guest' },
        status: 'ready',
      });

      const noDeployment = await fixture.app.inject({
        method: 'POST',
        url: '/api/plans/lxc-create',
        headers: {
          cookie: fixture.admin.cookie,
          [CSRF_HEADER_NAME]: fixture.admin.csrf,
        },
        payload: { hostId: 'pve-01', vmid: 115 },
      });
      expect(noDeployment.statusCode).toBe(409);
      expect(noDeployment.json().message).toContain('No deployment YAML');
    } finally {
      await fixture.app.close();
      fixture.handle.close();
    }
  });

  it('creates VM creation plans for administrators', async () => {
    const fixture = await createFixture();
    try {
      const denied = await fixture.app.inject({
        method: 'POST',
        url: '/api/plans/vm-create',
        headers: {
          cookie: fixture.operator.cookie,
          [CSRF_HEADER_NAME]: fixture.operator.csrf,
        },
        payload: { hostId: 'pve-01', vmid: 214 },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().message).toContain('administrators');

      const created = await fixture.app.inject({
        method: 'POST',
        url: '/api/plans/vm-create',
        headers: {
          cookie: fixture.admin.cookie,
          [CSRF_HEADER_NAME]: fixture.admin.csrf,
        },
        payload: { hostId: 'pve-01', vmid: 214 },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({
        operation: 'guest.create',
        target: { hostId: 'pve-01', vmid: 214, resourceType: 'guest' },
        status: 'ready',
        summary: 'Create VM 214 (new-vm) from template 9000',
        changes: [
          expect.objectContaining({
            id: 'create-guest',
            after: expect.objectContaining({
              type: 'vm',
              template: 'template 9000',
            }),
          }),
        ],
      });

      const wrongType = await fixture.app.inject({
        method: 'POST',
        url: '/api/plans/vm-create',
        headers: {
          cookie: fixture.admin.cookie,
          [CSRF_HEADER_NAME]: fixture.admin.csrf,
        },
        payload: { hostId: 'pve-01', vmid: 116 },
      });
      expect(wrongType.statusCode).toBe(409);
      expect(wrongType.json().message).toContain('VM creation only supports');
    } finally {
      await fixture.app.close();
      fixture.handle.close();
    }
  });

  it('creates LXC update plans for granted hosts and restricts other hosts', async () => {
    const fixture = await createFixture();
    try {
      const created = await fixture.app.inject({
        method: 'POST',
        url: '/api/plans/guest-update',
        headers: {
          cookie: fixture.operator.cookie,
          [CSRF_HEADER_NAME]: fixture.operator.csrf,
        },
        payload: { hostId: 'pve-01', vmid: 116 },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({
        operation: 'guest.update',
        target: { hostId: 'pve-01', vmid: 116, resourceType: 'guest' },
        status: 'ready',
        changes: [
          expect.objectContaining({ id: 'cpu', before: 2, after: 4 }),
          expect.objectContaining({ id: 'tags' }),
        ],
      });

      const denied = await fixture.app.inject({
        method: 'POST',
        url: '/api/plans/guest-update',
        headers: {
          cookie: fixture.operator.cookie,
          [CSRF_HEADER_NAME]: fixture.operator.csrf,
        },
        payload: { hostId: 'pve-02', vmid: 212 },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().message).toContain("Access denied to host 'pve-02'");
    } finally {
      await fixture.app.close();
      fixture.handle.close();
    }
  });
});

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../app.js';
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
} from '../../auth/session.js';
import { loadConfig } from '../../config.js';
import { createDatabase, createSqliteRepositories } from '../../db/index.js';
import type { ConsoleService } from '../../console/service.js';
import { consoleModuleInternals } from './index.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function readCookie(
  header: string | string[] | undefined,
  name: string,
): string {
  for (const value of Array.isArray(header) ? header : [header ?? '']) {
    const match = value.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    if (match) return match[1]!;
  }
  throw new Error(`Missing cookie '${name}'`);
}

function session(headers: Record<string, unknown>) {
  const header = headers['set-cookie'] as string | string[] | undefined;
  const sessionId = readCookie(header, SESSION_COOKIE_NAME);
  const csrf = readCookie(header, CSRF_COOKIE_NAME);
  return {
    cookie: `${SESSION_COOKIE_NAME}=${sessionId}; ${CSRF_COOKIE_NAME}=${csrf}`,
    csrf,
  };
}

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'hacm-console-data-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'hacm-console-state-'));
  directories.push(dataDir, stateDir);
  for (const [id, index] of [
    ['pve-01', 1],
    ['pve-02', 2],
  ] as const) {
    await mkdir(join(dataDir, 'hosts', id), { recursive: true });
    await writeFile(
      join(dataDir, 'hosts', id, 'host.yaml'),
      `schema_version: 1
id: ${id}
name: ${id}
type: proxmox
index: ${index}
connection:
  ssh:
    host: 192.0.2.${index}
`,
    );
  }
  const database = createDatabase({ path: ':memory:' });
  const repos = createSqliteRepositories(database.db);
  const open = vi.fn<ConsoleService['open']>(async (socket, context) => {
    socket.onMessage((data) => socket.send(data));
    socket.send(
      JSON.stringify({
        type: 'ready',
        target: context.request.target,
        hostId: context.request.hostId,
      }),
    );
  });
  const app = await buildApp({
    config: loadConfig({
      HACM_DATA_DIR: dataDir,
      HACM_STATE_DIR: stateDir,
      HACM_COOKIE_SECURE: 'false',
      HACM_SESSION_SECRET: 'c'.repeat(32),
    }),
    repositories: repos,
    consoleService: { open } as unknown as ConsoleService,
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
  return {
    app,
    database,
    open,
    admin,
    operator: session(operatorLogin.headers),
    viewer: session(viewerLogin.headers),
  };
}

function headers(cookie: string, origin = 'http://localhost:3000') {
  return { cookie, origin, host: 'localhost:3000' };
}

describe('console WebSocket API', () => {
  it('opens authorized host and LXC sessions and forwards messages', async () => {
    const test = await fixture();
    try {
      await test.app.ready();
      let resolveHostReady!: (value: string) => void;
      const hostReadyPromise = new Promise<string>((resolve) => {
        resolveHostReady = resolve;
      });
      const hostSocket = await test.app.injectWS(
        '/api/console?hostId=pve-01&target=host&cols=100&rows=30&recording=true',
        { headers: headers(test.operator.cookie) },
        {
          onOpen: (socket) => {
            socket.once('message', (data: unknown) =>
              resolveHostReady(String(data)),
            );
          },
        },
      );
      const hostReady = await hostReadyPromise;
      expect(JSON.parse(hostReady)).toMatchObject({
        type: 'ready',
        target: 'host',
      });
      hostSocket.terminate();

      let resolveLxcReady!: (value: string) => void;
      const lxcReadyPromise = new Promise<string>((resolve) => {
        resolveLxcReady = resolve;
      });
      const lxcSocket = await test.app.injectWS(
        '/api/console?hostId=pve-01&target=lxc&vmid=112',
        { headers: headers(test.operator.cookie) },
        {
          onOpen: (socket) => {
            socket.once('message', (data: unknown) =>
              resolveLxcReady(String(data)),
            );
          },
        },
      );
      expect(await lxcReadyPromise).toContain('ready');
      lxcSocket.terminate();
      expect(test.open).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          request: expect.objectContaining({
            hostId: 'pve-01',
            target: 'lxc',
            vmid: 112,
          }),
        }),
      );
    } finally {
      await test.app.close();
      test.database.close();
    }
  });

  it('denies viewers, ungranted hosts, missing hosts, invalid origins and malformed targets', async () => {
    const test = await fixture();
    try {
      await test.app.ready();
      await expect(
        test.app.injectWS('/api/console?hostId=pve-01&target=host', {
          headers: headers(test.viewer.cookie),
        }),
      ).rejects.toThrow('403');
      await expect(
        test.app.injectWS('/api/console?hostId=pve-02&target=host', {
          headers: headers(test.operator.cookie),
        }),
      ).rejects.toThrow('403');
      await expect(
        test.app.injectWS('/api/console?hostId=missing&target=host', {
          headers: headers(test.admin.cookie),
        }),
      ).rejects.toThrow('404');
      await expect(
        test.app.injectWS('/api/console?hostId=pve-01&target=host', {
          headers: headers(test.operator.cookie, 'https://evil.example'),
        }),
      ).rejects.toThrow('403');
      await expect(
        test.app.injectWS('/api/console?hostId=pve-01&target=lxc', {
          headers: headers(test.operator.cookie),
        }),
      ).rejects.toThrow('400');
    } finally {
      await test.app.close();
      test.database.close();
    }
  });

  it('validates same-origin headers and query defaults', () => {
    expect(
      consoleModuleInternals.hasSameOrigin({
        origin: 'https://example.test',
        host: 'example.test',
      }),
    ).toBe(true);
    expect(consoleModuleInternals.hasSameOrigin({ host: 'example.test' })).toBe(
      false,
    );
    expect(
      consoleModuleInternals.hasSameOrigin({
        origin: 'not a URL',
        host: 'example.test',
      }),
    ).toBe(false);
    expect(
      consoleModuleInternals.querySchema.parse({
        hostId: 'pve-01',
        target: 'host',
      }),
    ).toMatchObject({ cols: 80, rows: 24, recording: false });

    const listeners = new Map<string, (...args: unknown[]) => void>();
    const wire = {
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, listener);
      }),
    };
    const adapter = consoleModuleInternals.adaptConsoleSocket(wire as never);
    const message = vi.fn();
    const close = vi.fn();
    const error = vi.fn();
    adapter.onMessage(message);
    adapter.onClose(close);
    adapter.onError(error);
    adapter.send('fixture');
    adapter.close(1000, 'done');
    listeners.get('message')?.(Buffer.from('input'));
    listeners.get('close')?.();
    listeners.get('error')?.(new Error('fixture'));
    expect(wire.send).toHaveBeenCalledWith('fixture');
    expect(wire.close).toHaveBeenCalledWith(1000, 'done');
    expect(message).toHaveBeenCalledWith('input');
    expect(close).toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.any(Error));
  });
});

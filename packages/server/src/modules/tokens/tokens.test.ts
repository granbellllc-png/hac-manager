import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
} from '../../auth/session.js';
import { loadConfig } from '../../config.js';
import { createDatabase, createSqliteRepositories } from '../../db/index.js';
import { tokenModuleInternals } from './index.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function cookieValue(
  header: string | string[] | undefined,
  name: string,
): string {
  for (const value of Array.isArray(header) ? header : [header ?? '']) {
    const match = value.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    if (match) return match[1]!;
  }
  throw new Error(`Missing '${name}' cookie`);
}

function session(headers: Record<string, unknown>) {
  const header = headers['set-cookie'] as string | string[] | undefined;
  const sessionId = cookieValue(header, SESSION_COOKIE_NAME);
  const csrf = cookieValue(header, CSRF_COOKIE_NAME);
  return {
    cookie: `${SESSION_COOKIE_NAME}=${sessionId}; ${CSRF_COOKIE_NAME}=${csrf}`,
    csrf,
  };
}

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'hacm-token-data-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'hacm-token-state-'));
  directories.push(dataDir, stateDir);
  await mkdir(join(dataDir, 'hosts', 'pve-01'), { recursive: true });
  await writeFile(
    join(dataDir, 'hosts', 'pve-01', 'host.yaml'),
    `schema_version: 1
id: pve-01
name: Fixture Host
type: proxmox
index: 1
connection:
  ssh:
    host: 192.0.2.10
`,
  );
  const database = createDatabase({ path: ':memory:' });
  const repos = createSqliteRepositories(database.db);
  const app = await buildApp({
    config: loadConfig({
      HACM_DATA_DIR: dataDir,
      HACM_STATE_DIR: stateDir,
      HACM_COOKIE_SECURE: 'false',
      HACM_SESSION_SECRET: 't'.repeat(32),
    }),
    repositories: repos,
  });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { username: 'admin', password: 'Password123!' },
  });
  const admin = session(setup.headers);
  await app.inject({
    method: 'POST',
    url: '/api/users',
    headers: {
      cookie: admin.cookie,
      [CSRF_HEADER_NAME]: admin.csrf,
    },
    payload: {
      username: 'operator',
      password: 'Password-operator-123!',
      role: 'operator',
      grantedHosts: ['pve-01'],
    },
  });
  const operatorLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'operator', password: 'Password-operator-123!' },
  });
  return {
    app,
    database,
    repos,
    admin,
    operator: session(operatorLogin.headers),
  };
}

describe('personal API token endpoints', () => {
  it('creates, lists, authenticates, audits, and revokes a scoped token', async () => {
    const test = await fixture();
    try {
      expect(
        (
          await test.app.inject({
            method: 'POST',
            url: '/api/tokens',
            headers: {
              cookie: test.admin.cookie,
              [CSRF_HEADER_NAME]: test.admin.csrf,
            },
            payload: {
              name: 'bad password',
              scope: 'operator',
              password: 'wrong',
            },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await test.app.inject({
            method: 'POST',
            url: '/api/tokens',
            headers: {
              cookie: test.admin.cookie,
              [CSRF_HEADER_NAME]: test.admin.csrf,
            },
            payload: {
              name: 'bad expiry',
              scope: 'operator',
              password: 'Password123!',
              expiresAt: '2020-01-01T00:00:00.000Z',
            },
          })
        ).statusCode,
      ).toBe(400);

      const created = await test.app.inject({
        method: 'POST',
        url: '/api/tokens',
        headers: {
          cookie: test.admin.cookie,
          [CSRF_HEADER_NAME]: test.admin.csrf,
        },
        payload: {
          name: 'CLI automation',
          scope: 'operator',
          password: 'Password123!',
        },
      });
      expect(created.statusCode).toBe(201);
      const body = created.json<{
        token: string;
        item: { id: string; scope: string; prefix: string };
      }>();
      expect(body.token).toMatch(/^hacm_pat_/);
      expect(body.item).toMatchObject({ scope: 'operator' });

      const stored = JSON.stringify(
        await test.repos.apiTokens.listByUser(
          (await test.repos.users.getByUsername('admin'))!.id,
        ),
      );
      expect(stored).not.toContain(body.token);
      expect(stored).toContain('tokenHash');
      const audits = JSON.stringify(
        await test.repos.auditLogs.search({ action: 'token.create' }),
      );
      expect(audits).not.toContain(body.token);

      const authorization = { authorization: `Bearer ${body.token}` };
      const status = await test.app.inject({
        url: '/api/auth/status',
        headers: authorization,
      });
      expect(status.statusCode).toBe(200);
      expect(status.json().user).toMatchObject({
        username: 'admin',
        role: 'operator',
      });
      expect(
        (
          await test.app.inject({
            method: 'POST',
            url: '/api/auth/totp/setup',
            headers: authorization,
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await test.app.inject({
            method: 'POST',
            url: '/api/hosts/sync',
            headers: authorization,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (await test.app.inject({ url: '/api/tokens', headers: authorization }))
          .statusCode,
      ).toBe(403);
      expect(
        (
          await test.app.inject({
            method: 'POST',
            url: '/api/tokens',
            headers: authorization,
            payload: {
              name: 'nested token',
              scope: 'viewer',
              password: 'Password123!',
            },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await test.app.inject({
            method: 'DELETE',
            url: `/api/tokens/${body.item.id}`,
            headers: authorization,
          })
        ).statusCode,
      ).toBe(403);

      const listed = await test.app.inject({
        url: '/api/tokens',
        headers: { cookie: test.admin.cookie },
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toMatchObject({
        items: [expect.objectContaining({ id: body.item.id })],
        allowedScopes: ['viewer', 'operator', 'admin'],
      });
      expect(
        (
          await test.app.inject({
            method: 'DELETE',
            url: `/api/tokens/${body.item.id}`,
            headers: {
              cookie: test.admin.cookie,
              [CSRF_HEADER_NAME]: test.admin.csrf,
            },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await test.app.inject({
            method: 'DELETE',
            url: `/api/tokens/${body.item.id}`,
            headers: {
              cookie: test.admin.cookie,
              [CSRF_HEADER_NAME]: test.admin.csrf,
            },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (await test.app.inject({ url: '/api/hosts', headers: authorization }))
          .statusCode,
      ).toBe(401);
    } finally {
      await test.app.close();
      test.database.close();
    }
  });

  it('prevents token escalation and enforces viewer scope without CSRF', async () => {
    const test = await fixture();
    try {
      const escalation = await test.app.inject({
        method: 'POST',
        url: '/api/tokens',
        headers: {
          cookie: test.operator.cookie,
          [CSRF_HEADER_NAME]: test.operator.csrf,
        },
        payload: {
          name: 'too powerful',
          scope: 'admin',
          password: 'Password-operator-123!',
        },
      });
      expect(escalation.statusCode).toBe(403);

      const created = await test.app.inject({
        method: 'POST',
        url: '/api/tokens',
        headers: {
          cookie: test.operator.cookie,
          [CSRF_HEADER_NAME]: test.operator.csrf,
        },
        payload: {
          name: 'read only',
          scope: 'viewer',
          password: 'Password-operator-123!',
        },
      });
      const token = created.json<{ token: string }>().token;
      expect(created.statusCode).toBe(201);
      expect(
        (
          await test.app.inject({
            method: 'POST',
            url: '/api/hosts/sync',
            headers: { authorization: `Bearer ${token}` },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await test.app.inject({
            url: '/api/hosts',
            headers: { authorization: 'Bearer malformed' },
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      await test.app.close();
      test.database.close();
    }
  });

  it('validates session and expiry helpers', () => {
    expect(tokenModuleInternals.sessionOnly({ authMethod: 'session' })).toBe(
      true,
    );
    expect(tokenModuleInternals.sessionOnly({ authMethod: 'token' })).toBe(
      false,
    );
    const now = new Date('2026-11-10T10:00:00.000Z');
    expect(tokenModuleInternals.validateExpiry(undefined, now)).toBeNull();
    expect(tokenModuleInternals.validateExpiry('bad', now)).toBeNull();
    expect(
      tokenModuleInternals.validateExpiry('2026-11-11T10:00:00.000Z', now),
    ).toEqual(new Date('2026-11-11T10:00:00.000Z'));
    expect(
      tokenModuleInternals.validateExpiry('2028-11-10T10:00:00.000Z', now),
    ).toBeNull();
  });
});

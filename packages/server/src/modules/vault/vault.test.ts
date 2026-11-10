import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SecretManager, type VaultProvider } from '@hacm/core';
import { buildApp } from '../../app.js';
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
} from '../../auth/session.js';
import { loadConfig } from '../../config.js';
import { createDatabase, createSqliteRepositories } from '../../db/index.js';
import { HostRegistry } from '../../hosts/registry.js';
import { VaultService } from '../../vault/service.js';

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
  throw new Error(`Missing ${name} cookie`);
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

describe('vault provider API', () => {
  it('exposes safe status and keeps unlock tokens out of API and audit persistence', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'hacm-vault-api-data-'));
    const stateDir = await mkdtemp(join(tmpdir(), 'hacm-vault-api-state-'));
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
    password: !cmd "fixture-vault read password"
`,
    );
    await mkdir(join(dataDir, 'hosts', 'pve-02'), { recursive: true });
    await writeFile(
      join(dataDir, 'hosts', 'pve-02', 'host.yaml'),
      `schema_version: 1
id: pve-02
name: Other Host
type: proxmox
index: 2
connection:
  ssh:
    host: 192.0.2.11
`,
    );
    const database = createDatabase({ path: ':memory:' });
    const repos = createSqliteRepositories(database.db);
    const registry = new HostRegistry({ dataDir, repos });
    await registry.sync();
    let unlocked = false;
    const provider: VaultProvider = {
      id: 'fixture',
      name: 'Fixture Vault',
      commands: ['fixture-vault'],
      tokenLabel: 'Fixture token',
      helpText: 'Fixture help',
      async status() {
        return unlocked
          ? { status: 'unlocked' }
          : { status: 'locked', reason: 'fixture vault locked' };
      },
      async unlock(token) {
        unlocked = token === 'valid-token';
        return unlocked
          ? { status: 'unlocked' }
          : { status: 'locked', reason: 'invalid token' };
      },
      clear() {
        unlocked = false;
      },
      environment() {
        return {};
      },
    };
    const manager = new SecretManager({
      dataDir,
      vaultProviders: [provider],
    });
    const vaultService = new VaultService(manager, registry, repos);
    const app = await buildApp({
      config: loadConfig({
        HACM_DATA_DIR: dataDir,
        HACM_STATE_DIR: stateDir,
        HACM_COOKIE_SECURE: 'false',
        HACM_SESSION_SECRET: 'v'.repeat(32),
      }),
      repositories: repos,
      hostRegistry: registry,
      vaultService,
    });
    try {
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
        payload: {
          username: 'operator',
          password: 'Password-operator-123!',
        },
      });
      const operator = session(operatorLogin.headers);

      const status = await app.inject({
        url: '/api/hosts/pve-01/vault/providers',
        headers: { cookie: operator.cookie },
      });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toEqual({
        providers: [
          expect.objectContaining({ id: 'fixture', status: 'locked' }),
        ],
      });
      expect(
        (
          await app.inject({
            url: '/api/hosts/pve-02/vault/providers',
            headers: { cookie: operator.cookie },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            url: '/api/hosts/missing/vault/providers',
            headers: { cookie: admin.cookie },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            url: '/api/hosts/pve-02/vault/providers',
            headers: { cookie: admin.cookie },
          })
        ).json(),
      ).toEqual({ providers: [] });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/hosts/pve-01/vault/providers/fixture/unlock',
            headers: {
              cookie: operator.cookie,
              [CSRF_HEADER_NAME]: operator.csrf,
            },
            payload: { token: 'operator-token' },
          })
        ).statusCode,
      ).toBe(403);

      const invalid = await app.inject({
        method: 'POST',
        url: '/api/hosts/pve-01/vault/providers/fixture/unlock',
        headers: {
          cookie: admin.cookie,
          [CSRF_HEADER_NAME]: admin.csrf,
        },
        payload: { token: 'invalid-token-value' },
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.body).not.toContain('invalid-token-value');
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/hosts/missing/vault/providers/fixture/unlock',
            headers: {
              cookie: admin.cookie,
              [CSRF_HEADER_NAME]: admin.csrf,
            },
            payload: { token: 'unused-token' },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/hosts/pve-01/vault/providers/other/unlock',
            headers: {
              cookie: admin.cookie,
              [CSRF_HEADER_NAME]: admin.csrf,
            },
            payload: { token: 'unused-token' },
          })
        ).statusCode,
      ).toBe(404);

      const unlockedResponse = await app.inject({
        method: 'POST',
        url: '/api/hosts/pve-01/vault/providers/fixture/unlock',
        headers: {
          cookie: admin.cookie,
          [CSRF_HEADER_NAME]: admin.csrf,
        },
        payload: { token: 'valid-token' },
      });
      expect(unlockedResponse.statusCode).toBe(200);
      expect(unlockedResponse.json()).toMatchObject({
        id: 'fixture',
        status: 'unlocked',
      });
      const audit = JSON.stringify(
        await repos.auditLogs.search({ action: 'vault.unlock' }),
      );
      expect(audit).not.toContain('valid-token');
      expect(audit).toContain('memory_only');
    } finally {
      await app.close();
      database.close();
    }
  });
});

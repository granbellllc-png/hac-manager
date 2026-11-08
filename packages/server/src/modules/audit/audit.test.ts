import { describe, expect, it } from 'vitest';
import { Secret } from '@hacm/core';
import { loadConfig } from '../../config.js';
import { buildApp } from '../../app.js';
import { createDatabase, createSqliteRepositories } from '../../db/index.js';
import {
  SESSION_COOKIE_NAME,
  CSRF_HEADER_NAME,
  CSRF_COOKIE_NAME,
} from '../../auth/session.js';

function parseCookie(
  cookieHeader: string | string[] | undefined,
  name: string,
): string | undefined {
  if (!cookieHeader) return undefined;
  const headers = Array.isArray(cookieHeader) ? cookieHeader : [cookieHeader];
  for (const h of headers) {
    const match = h.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    if (match) return match[1];
  }
  return undefined;
}

interface AuditItemResponse {
  id: string;
  userId: string | null;
  username: string | null;
  hostId: string | null;
  vmid: number | null;
  action: string;
  reason: string;
  jobId: string | null;
  diffJson: string | null;
  metadataJson: string | null;
  createdAt: string;
}

interface AuditListResponse {
  items: AuditItemResponse[];
  total: number;
  limit: number;
  offset: number;
}

describe('Audit module and redaction guarantees', () => {
  const config = loadConfig({
    HACM_DATA_DIR: 'examples/data',
    HACM_STATE_DIR: 'state',
    HACM_COOKIE_SECURE: 'false',
    HACM_SESSION_SECRET: 'c'.repeat(32),
    HACM_SECRET_KEY: 'test-secret-key-for-audit-log-at-rest!',
  });

  it('guarantees audit rows NEVER contain secret values or passwords in diffs or metadata', async () => {
    const handle = createDatabase({ path: ':memory:' });
    try {
      const repos = createSqliteRepositories(handle.db);

      const secretToken = new Secret('super-sensitive-api-token-xyz');
      const row = await repos.auditLogs.append({
        userId: 'u1',
        username: 'alice',
        action: 'guest.apply',
        reason: 'manual',
        diff: {
          password: 'plainPassword123!',
          api_key: 'my-api-key',
          nested: {
            token: secretToken,
            safeField: 'harmless-value',
          },
        },
        metadata: {
          session_id: 'session-token-1234',
          author: 'alice',
        },
      });

      expect(row.diffJson).toBeDefined();
      expect(row.diffJson).not.toContain('super-sensitive-api-token-xyz');
      expect(row.diffJson).not.toContain('plainPassword123!');
      expect(row.diffJson).not.toContain('my-api-key');
      expect(row.metadataJson).not.toContain('session-token-1234');

      const parsedDiff = JSON.parse(row.diffJson!);
      expect(parsedDiff.password).toBe('***');
      expect(parsedDiff.api_key).toBe('***');
      expect(parsedDiff.nested.token).toBe('***');
      expect(parsedDiff.nested.safeField).toBe('harmless-value');

      const parsedMeta = JSON.parse(row.metadataJson!);
      expect(parsedMeta.session_id).toBe('***');
      expect(parsedMeta.author).toBe('alice');
    } finally {
      handle.close();
    }
  });

  it('supports filtering by user, host, vmid, reason, and time range with pagination', async () => {
    const handle = createDatabase({ path: ':memory:' });
    try {
      const repos = createSqliteRepositories(handle.db);
      const app = await buildApp({ config, repositories: repos });

      // Create admin user
      const setupRes = await app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        payload: { username: 'admin', password: 'AdminPassword123!' },
      });
      const setupCookies = setupRes.headers['set-cookie'];
      const session = parseCookie(setupCookies, SESSION_COOKIE_NAME);
      const csrf = parseCookie(setupCookies, CSRF_COOKIE_NAME);
      const authHeaders = {
        cookie: `${SESSION_COOKIE_NAME}=${session}; ${CSRF_COOKIE_NAME}=${csrf}`,
        [CSRF_HEADER_NAME]: csrf ?? '',
      };

      const t0 = 1700000000000;
      // Seed audit entries
      await repos.auditLogs.append({
        userId: 'u-admin',
        username: 'admin',
        hostId: 'pve-01',
        vmid: 101,
        action: 'guest.create',
        reason: 'manual',
        createdAt: new Date(t0 + 1000),
      });

      await repos.auditLogs.append({
        userId: 'u-operator',
        username: 'operator1',
        hostId: 'pve-01',
        vmid: 102,
        action: 'guest.apply',
        reason: 'drift_push',
        createdAt: new Date(t0 + 2000),
      });

      await repos.auditLogs.append({
        userId: 'u-system',
        username: 'system',
        hostId: 'pve-02',
        vmid: 201,
        action: 'drift.resolve',
        reason: 'conflict_resolution',
        createdAt: new Date(t0 + 3000),
      });

      // 1. Filter by hostId
      const pve01Res = await app.inject({
        method: 'GET',
        url: '/api/audit?hostId=pve-01',
        headers: authHeaders,
      });
      expect(pve01Res.statusCode).toBe(200);
      const pve01Data = pve01Res.json<AuditListResponse>();
      expect(pve01Data.total).toBe(2);
      expect(pve01Data.items.every((it) => it.hostId === 'pve-01')).toBe(true);

      // 2. Filter by vmid
      const vmidRes = await app.inject({
        method: 'GET',
        url: '/api/audit?vmid=201',
        headers: authHeaders,
      });
      expect(vmidRes.statusCode).toBe(200);
      expect(vmidRes.json<AuditListResponse>().total).toBe(1);
      expect(vmidRes.json<AuditListResponse>().items[0]?.vmid).toBe(201);

      // 3. Filter by reason
      const reasonRes = await app.inject({
        method: 'GET',
        url: '/api/audit?reason=drift_push',
        headers: authHeaders,
      });
      expect(reasonRes.statusCode).toBe(200);
      expect(reasonRes.json<AuditListResponse>().total).toBe(1);
      expect(reasonRes.json<AuditListResponse>().items[0]?.reason).toBe(
        'drift_push',
      );

      // 4. Filter by username
      const userRes = await app.inject({
        method: 'GET',
        url: '/api/audit?username=operator1',
        headers: authHeaders,
      });
      expect(userRes.statusCode).toBe(200);
      expect(userRes.json<AuditListResponse>().total).toBe(1);

      // 5. Filter by time window
      const timeRes = await app.inject({
        method: 'GET',
        url: `/api/audit?from=${t0 + 1500}&to=${t0 + 2500}`,
        headers: authHeaders,
      });
      expect(timeRes.statusCode).toBe(200);
      expect(timeRes.json<AuditListResponse>().total).toBe(1);
      expect(timeRes.json<AuditListResponse>().items[0]?.action).toBe(
        'guest.apply',
      );

      // 6. Pagination (limit=1, offset=1)
      const pageRes = await app.inject({
        method: 'GET',
        url: '/api/audit?limit=1&offset=1',
        headers: authHeaders,
      });
      expect(pageRes.statusCode).toBe(200);
      const pageData = pageRes.json<AuditListResponse>();
      expect(pageData.items).toHaveLength(1);
      expect(pageData.limit).toBe(1);
      expect(pageData.offset).toBe(1);
    } finally {
      handle.close();
    }
  });

  it('enforces RBAC host scoping for non-admin viewers and operators', async () => {
    const handle = createDatabase({ path: ':memory:' });
    try {
      const repos = createSqliteRepositories(handle.db);
      const app = await buildApp({ config, repositories: repos });

      // Create admin user
      const setupRes = await app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        payload: { username: 'admin', password: 'AdminPassword123!' },
      });
      const setupCookies = setupRes.headers['set-cookie'];
      const sessionAdmin = parseCookie(setupCookies, SESSION_COOKIE_NAME);
      const csrfAdmin = parseCookie(setupCookies, CSRF_COOKIE_NAME);
      const adminHeaders = {
        cookie: `${SESSION_COOKIE_NAME}=${sessionAdmin}; ${CSRF_COOKIE_NAME}=${csrfAdmin}`,
        [CSRF_HEADER_NAME]: csrfAdmin ?? '',
      };

      // Create operator user with access only to pve-01
      const createOpRes = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: adminHeaders,
        payload: {
          username: 'operator-scoped',
          password: 'OperatorPassword123!',
          role: 'operator',
          grantedHosts: ['pve-01'],
        },
      });
      expect(createOpRes.statusCode).toBe(201);

      // Seed audit entries: one on pve-01, one on pve-02
      const entryPve01 = await repos.auditLogs.append({
        hostId: 'pve-01',
        action: 'guest.update',
        reason: 'manual',
      });
      const entryPve02 = await repos.auditLogs.append({
        hostId: 'pve-02',
        action: 'guest.destroy',
        reason: 'manual',
      });

      // Operator logs in
      const opLoginRes = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          username: 'operator-scoped',
          password: 'OperatorPassword123!',
        },
      });
      const opCookies = opLoginRes.headers['set-cookie'];
      const sessionOp = parseCookie(opCookies, SESSION_COOKIE_NAME);
      const csrfOp = parseCookie(opCookies, CSRF_COOKIE_NAME);
      const opHeaders = {
        cookie: `${SESSION_COOKIE_NAME}=${sessionOp}; ${CSRF_COOKIE_NAME}=${csrfOp}`,
        [CSRF_HEADER_NAME]: csrfOp ?? '',
      };

      // Operator searches all audit logs: only sees pve-01
      const opAuditList = await app.inject({
        method: 'GET',
        url: '/api/audit',
        headers: opHeaders,
      });
      expect(opAuditList.statusCode).toBe(200);
      const opItems = opAuditList.json<AuditListResponse>().items;
      expect(opItems.every((it) => it.hostId === 'pve-01')).toBe(true);
      expect(opItems.some((it) => it.hostId === 'pve-02')).toBe(false);

      // Operator gets entry for pve-01 -> 200
      const get01Res = await app.inject({
        method: 'GET',
        url: `/api/audit/${entryPve01.id}`,
        headers: opHeaders,
      });
      expect(get01Res.statusCode).toBe(200);

      // Operator gets entry for pve-02 -> 403 Forbidden
      const get02Res = await app.inject({
        method: 'GET',
        url: `/api/audit/${entryPve02.id}`,
        headers: opHeaders,
      });
      expect(get02Res.statusCode).toBe(403);
    } finally {
      handle.close();
    }
  });

  it('rejects unauthenticated requests with 401', async () => {
    const handle = createDatabase({ path: ':memory:' });
    try {
      const repos = createSqliteRepositories(handle.db);
      const app = await buildApp({ config, repositories: repos });

      const res = await app.inject({
        method: 'GET',
        url: '/api/audit',
      });
      expect(res.statusCode).toBe(401);
    } finally {
      handle.close();
    }
  });
});

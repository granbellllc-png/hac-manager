import { describe, expect, it } from 'vitest';
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

interface UserResponse {
  id: string;
  username: string;
  role: 'admin' | 'operator' | 'viewer';
  autoGrantNewHosts: boolean;
  grantedHosts: string[];
  createdAt: number;
  updatedAt: number;
}

describe('Users API endpoints (Admin only)', () => {
  const config = loadConfig({
    HACM_DATA_DIR: 'examples/data',
    HACM_STATE_DIR: 'state',
    HACM_COOKIE_SECURE: 'false',
    HACM_SESSION_SECRET: 'b'.repeat(32),
  });

  async function setupAdminApp() {
    const handle = createDatabase({ path: ':memory:' });
    const repos = createSqliteRepositories(handle.db);
    const app = await buildApp({ config, repositories: repos });

    // Setup initial admin
    const setupRes = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: {
        username: 'admin',
        password: 'Password123!',
      },
    });

    const cookies = setupRes.headers['set-cookie'];
    const session = parseCookie(cookies, SESSION_COOKIE_NAME)!;
    const csrf = parseCookie(cookies, CSRF_COOKIE_NAME)!;
    const cookieHeader = `${SESSION_COOKIE_NAME}=${session}; ${CSRF_COOKIE_NAME}=${csrf}`;

    return { handle, repos, app, cookieHeader, csrf };
  }

  it('allows admin to list, create, update, and delete users with host access', async () => {
    const { handle, app, cookieHeader, csrf } = await setupAdminApp();
    try {
      // 1. List users (initially just admin)
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/users',
        headers: { cookie: cookieHeader },
      });
      expect(listRes.statusCode).toBe(200);
      const list = listRes.json<UserResponse[]>();
      expect(list).toHaveLength(1);
      expect(list[0]?.username).toBe('admin');
      expect(list[0]?.role).toBe('admin');

      // 2. Create new operator user with granted hosts
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: {
          cookie: cookieHeader,
          [CSRF_HEADER_NAME]: csrf,
        },
        payload: {
          username: 'operator1',
          password: 'PasswordOperator123!',
          role: 'operator',
          autoGrantNewHosts: true,
          grantedHosts: ['pve-01', 'pve-02'],
        },
      });
      expect(createRes.statusCode).toBe(201);
      const created = createRes.json<UserResponse>();
      expect(created.username).toBe('operator1');
      expect(created.role).toBe('operator');
      expect(created.grantedHosts).toEqual(['pve-01', 'pve-02']);

      // 3. Update operator user (change role to viewer and update hosts)
      const updateRes = await app.inject({
        method: 'PUT',
        url: `/api/users/${created.id}`,
        headers: {
          cookie: cookieHeader,
          [CSRF_HEADER_NAME]: csrf,
        },
        payload: {
          role: 'viewer',
          grantedHosts: ['pve-01'],
        },
      });
      expect(updateRes.statusCode).toBe(200);
      const updated = updateRes.json<UserResponse>();
      expect(updated.role).toBe('viewer');
      expect(updated.grantedHosts).toEqual(['pve-01']);

      // 4. Delete user
      const deleteRes = await app.inject({
        method: 'DELETE',
        url: `/api/users/${created.id}`,
        headers: {
          cookie: cookieHeader,
          [CSRF_HEADER_NAME]: csrf,
        },
      });
      expect(deleteRes.statusCode).toBe(200);
      expect(deleteRes.json()).toEqual({
        message: 'User deleted successfully',
      });

      // Verify list has only admin left
      const afterList = await app.inject({
        method: 'GET',
        url: '/api/users',
        headers: { cookie: cookieHeader },
      });
      expect(afterList.json<UserResponse[]>()).toHaveLength(1);
    } finally {
      handle.close();
    }
  });

  it('prevents non-admins from managing users', async () => {
    const { handle, app, cookieHeader, csrf } = await setupAdminApp();
    try {
      // Create a viewer user
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: {
          cookie: cookieHeader,
          [CSRF_HEADER_NAME]: csrf,
        },
        payload: {
          username: 'viewer1',
          password: 'PasswordViewer123!',
          role: 'viewer',
        },
      });
      expect(createRes.statusCode).toBe(201);

      // Log in as viewer1
      const viewerLogin = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          username: 'viewer1',
          password: 'PasswordViewer123!',
        },
      });
      expect(viewerLogin.statusCode).toBe(200);

      const viewerCookies = viewerLogin.headers['set-cookie'];
      const vSession = parseCookie(viewerCookies, SESSION_COOKIE_NAME)!;
      const vCsrf = parseCookie(viewerCookies, CSRF_COOKIE_NAME)!;
      const vHeader = `${SESSION_COOKIE_NAME}=${vSession}; ${CSRF_COOKIE_NAME}=${vCsrf}`;

      // Viewer attempts to access /api/users -> 403 Forbidden
      const viewerGetRes = await app.inject({
        method: 'GET',
        url: '/api/users',
        headers: { cookie: vHeader },
      });
      expect(viewerGetRes.statusCode).toBe(403);
      expect(viewerGetRes.json()).toMatchObject({
        statusCode: 403,
        error: 'Forbidden',
      });
    } finally {
      handle.close();
    }
  });
});

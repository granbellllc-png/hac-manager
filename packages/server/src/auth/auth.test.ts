import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { buildApp } from '../app.js';
import { createDatabase, createSqliteRepositories } from '../db/index.js';
import {
  SESSION_COOKIE_NAME,
  CSRF_HEADER_NAME,
  CSRF_COOKIE_NAME,
} from './session.js';

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

describe('Authentication module', () => {
  const config = loadConfig({
    HACM_DATA_DIR: 'examples/data',
    HACM_STATE_DIR: 'state',
    HACM_COOKIE_SECURE: 'false',
    HACM_SESSION_SECRET: 'a'.repeat(32),
  });

  it('rejects unauthenticated requests to protected /api endpoints with 401', async () => {
    const handle = createDatabase({ path: ':memory:' });
    try {
      const repos = createSqliteRepositories(handle.db);
      const app = await buildApp({ config, repositories: repos });

      // Add a dummy protected route to test middleware
      app.get('/api/protected-resource', async () => ({ secret: 'ok' }));

      const res = await app.inject({
        method: 'GET',
        url: '/api/protected-resource',
      });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({
        statusCode: 401,
        error: 'Unauthorized',
      });
    } finally {
      handle.close();
    }
  });

  it('allows public endpoints without authentication', async () => {
    const handle = createDatabase({ path: ':memory:' });
    try {
      const repos = createSqliteRepositories(handle.db);
      const app = await buildApp({ config, repositories: repos });

      const healthRes = await app.inject({
        method: 'GET',
        url: '/api/health',
      });
      expect(healthRes.statusCode).toBe(200);

      const statusRes = await app.inject({
        method: 'GET',
        url: '/api/auth/status',
      });
      expect(statusRes.statusCode).toBe(200);
      expect(statusRes.json()).toEqual({
        setupNeeded: true,
        user: null,
      });
    } finally {
      handle.close();
    }
  });

  it('handles first-run setup and locks subsequent setup calls', async () => {
    const handle = createDatabase({ path: ':memory:' });
    try {
      const repos = createSqliteRepositories(handle.db);
      const app = await buildApp({ config, repositories: repos });

      // First call succeeds
      const setupRes = await app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        payload: {
          username: 'admin',
          password: 'Password123!',
        },
      });

      expect(setupRes.statusCode).toBe(201);
      expect(setupRes.json()).toMatchObject({
        message: 'Admin user created successfully',
        user: { username: 'admin', role: 'admin' },
      });

      // Cookies were set
      const cookies = setupRes.headers['set-cookie'];
      expect(parseCookie(cookies, SESSION_COOKIE_NAME)).toBeDefined();
      expect(parseCookie(cookies, CSRF_COOKIE_NAME)).toBeDefined();

      // Subsequent setup calls are locked with 409 Conflict
      const secondSetup = await app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        payload: {
          username: 'another_admin',
          password: 'AnotherPassword123!',
        },
      });

      expect(secondSetup.statusCode).toBe(409);
      expect(secondSetup.json()).toMatchObject({
        statusCode: 409,
        error: 'Conflict',
      });
    } finally {
      handle.close();
    }
  });

  it('handles login, session verification, CSRF, and logout', async () => {
    const handle = createDatabase({ path: ':memory:' });
    try {
      const repos = createSqliteRepositories(handle.db);
      const app = await buildApp({ config, repositories: repos });

      // Add a dummy mutating route to test CSRF verification
      app.post('/api/test-mutation', async () => ({ modified: true }));

      // Setup admin user
      await app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        payload: {
          username: 'admin',
          password: 'Password123!',
        },
      });

      // Login
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          username: 'admin',
          password: 'Password123!',
        },
      });

      expect(loginRes.statusCode).toBe(200);
      const cookies = loginRes.headers['set-cookie'];
      const sessionVal = parseCookie(cookies, SESSION_COOKIE_NAME);
      const csrfVal = parseCookie(cookies, CSRF_COOKIE_NAME);
      expect(sessionVal).toBeDefined();
      expect(csrfVal).toBeDefined();

      const cookieHeader = `${SESSION_COOKIE_NAME}=${sessionVal}; ${CSRF_COOKIE_NAME}=${csrfVal}`;

      // Check auth status with session cookie
      const statusRes = await app.inject({
        method: 'GET',
        url: '/api/auth/status',
        headers: {
          cookie: cookieHeader,
        },
      });
      expect(statusRes.statusCode).toBe(200);
      expect(statusRes.json()).toMatchObject({
        setupNeeded: false,
        user: { username: 'admin', role: 'admin' },
      });

      // Mutating request without CSRF header fails with 403
      const noCsrfRes = await app.inject({
        method: 'POST',
        url: '/api/test-mutation',
        headers: {
          cookie: cookieHeader,
        },
        payload: {},
      });
      expect(noCsrfRes.statusCode).toBe(403);

      // Mutating request with CSRF header succeeds
      const csrfRes = await app.inject({
        method: 'POST',
        url: '/api/test-mutation',
        headers: {
          cookie: cookieHeader,
          [CSRF_HEADER_NAME]: csrfVal!,
        },
        payload: {},
      });
      expect(csrfRes.statusCode).toBe(200);
      expect(csrfRes.json()).toEqual({ modified: true });

      // Change password
      const changePassRes = await app.inject({
        method: 'POST',
        url: '/api/auth/password',
        headers: {
          cookie: cookieHeader,
          [CSRF_HEADER_NAME]: csrfVal!,
        },
        payload: {
          currentPassword: 'Password123!',
          newPassword: 'BrandNewPassword999!',
        },
      });
      expect(changePassRes.statusCode).toBe(200);

      // Old password no longer works
      const oldLoginRes = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          username: 'admin',
          password: 'Password123!',
        },
      });
      expect(oldLoginRes.statusCode).toBe(401);

      // New password works
      const newLoginRes = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          username: 'admin',
          password: 'BrandNewPassword999!',
        },
      });
      expect(newLoginRes.statusCode).toBe(200);

      // Logout everywhere
      const newCookies = newLoginRes.headers['set-cookie'];
      const newSession = parseCookie(newCookies, SESSION_COOKIE_NAME);
      const newCsrf = parseCookie(newCookies, CSRF_COOKIE_NAME);
      const newCookieHeader = `${SESSION_COOKIE_NAME}=${newSession}; ${CSRF_COOKIE_NAME}=${newCsrf}`;

      const logoutEverywhereRes = await app.inject({
        method: 'POST',
        url: '/api/auth/logout-everywhere',
        headers: {
          cookie: newCookieHeader,
          [CSRF_HEADER_NAME]: newCsrf!,
        },
      });
      expect(logoutEverywhereRes.statusCode).toBe(200);

      // Active session is now invalid
      const afterLogoutRes = await app.inject({
        method: 'POST',
        url: '/api/test-mutation',
        headers: {
          cookie: newCookieHeader,
          [CSRF_HEADER_NAME]: newCsrf!,
        },
        payload: {},
      });
      expect(afterLogoutRes.statusCode).toBe(401);
    } finally {
      handle.close();
    }
  });

  it('enforces login rate limiting and lockout on brute-force attempts', async () => {
    const handle = createDatabase({ path: ':memory:' });
    try {
      const repos = createSqliteRepositories(handle.db);
      const app = await buildApp({ config, repositories: repos });

      // Create user
      await app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        payload: {
          username: 'target_admin',
          password: 'CorrectPassword1!',
        },
      });

      // Send 5 incorrect passwords
      for (let i = 0; i < 5; i++) {
        const failRes = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: {
            username: 'target_admin',
            password: `WrongPassword${i}!`,
          },
        });
        if (i < 4) {
          expect(failRes.statusCode).toBe(401);
        } else {
          // 5th attempt trips the lockout
          expect(failRes.statusCode).toBe(429);
          expect(failRes.json()).toMatchObject({
            statusCode: 429,
            error: 'Too Many Requests',
          });
        }
      }

      // Even correct password now gets throttled with 429 during lockout window
      const lockedRes = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          username: 'target_admin',
          password: 'CorrectPassword1!',
        },
      });
      expect(lockedRes.statusCode).toBe(429);
    } finally {
      handle.close();
    }
  });

  it('includes security headers in responses', async () => {
    const handle = createDatabase({ path: ':memory:' });
    try {
      const repos = createSqliteRepositories(handle.db);
      const app = await buildApp({ config, repositories: repos });

      const res = await app.inject({
        method: 'GET',
        url: '/api/health',
      });

      expect(res.headers['content-security-policy']).toBeDefined();
      expect(res.headers['x-frame-options']).toBe('DENY');
    } finally {
      handle.close();
    }
  });
});

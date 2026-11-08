import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { buildApp } from '../app.js';
import { createDatabase, createSqliteRepositories } from '../db/index.js';
import { generateTotp } from './totp.js';
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

interface TotpSetupResponse {
  secret: string;
  uri: string;
  qrCode: string;
  recoveryCodes: string[];
}

interface TotpStatusResponse {
  enabled: boolean;
  remainingRecoveryCodes: number;
}

interface AuthStatusResponse {
  setupNeeded: boolean;
  user: {
    id: string;
    username: string;
    role: string;
    totpEnabled: boolean;
  } | null;
}

describe('TOTP 2FA end-to-end enrollment and recovery flow', () => {
  const config = loadConfig({
    HACM_DATA_DIR: 'examples/data',
    HACM_STATE_DIR: 'state',
    HACM_COOKIE_SECURE: 'false',
    HACM_SESSION_SECRET: 'b'.repeat(32),
    HACM_SECRET_KEY: 'encryption-app-key-secret-at-rest-min-32-chars!',
  });

  it('completes full lifecycle: enroll, 2FA login, recovery code login, disable, and admin reset', async () => {
    const handle = createDatabase({ path: ':memory:' });
    try {
      const repos = createSqliteRepositories(handle.db);
      const app = await buildApp({ config, repositories: repos });

      // 1. Initial setup creates admin user
      const setupRes = await app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        payload: {
          username: 'admin',
          password: 'AdminPassword123!',
        },
      });
      expect(setupRes.statusCode).toBe(201);
      const setupCookies = setupRes.headers['set-cookie'];
      const session1 = parseCookie(setupCookies, SESSION_COOKIE_NAME);
      const csrf1 = parseCookie(setupCookies, CSRF_COOKIE_NAME);
      expect(session1).toBeDefined();
      expect(csrf1).toBeDefined();

      const authHeaders1 = {
        cookie: `${SESSION_COOKIE_NAME}=${session1}; ${CSRF_COOKIE_NAME}=${csrf1}`,
        [CSRF_HEADER_NAME]: csrf1 ?? '',
      };

      // 2. Check initial TOTP status (disabled)
      const statusRes = await app.inject({
        method: 'GET',
        url: '/api/auth/totp/status',
        headers: authHeaders1,
      });
      expect(statusRes.statusCode).toBe(200);
      expect(statusRes.json<TotpStatusResponse>()).toEqual({
        enabled: false,
        remainingRecoveryCodes: 0,
      });

      // 3. Initiate TOTP setup
      const totpSetupRes = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/setup',
        headers: authHeaders1,
      });
      expect(totpSetupRes.statusCode).toBe(200);
      const setupData = totpSetupRes.json<TotpSetupResponse>();
      expect(setupData.secret).toBeDefined();
      expect(setupData.uri).toContain('otpauth://totp/');
      expect(setupData.qrCode.startsWith('data:image/png;base64,')).toBe(true);
      expect(setupData.recoveryCodes).toHaveLength(8);

      // Verify that secret at rest in SQLite is encrypted, not plaintext Base32
      const rawUser = await repos.users.getByUsername('admin');
      expect(rawUser?.totpSecret).toBeDefined();
      expect(rawUser?.totpSecret?.startsWith('v1:')).toBe(true);
      expect(rawUser?.totpSecret).not.toContain(setupData.secret);

      // 4. Try enabling with wrong code
      const failEnable = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/enable',
        headers: authHeaders1,
        payload: { code: '000000' },
      });
      expect(failEnable.statusCode).toBe(400);

      // 5. Enable with valid code
      const validCode = generateTotp(setupData.secret);
      const successEnable = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/enable',
        headers: authHeaders1,
        payload: { code: validCode },
      });
      expect(successEnable.statusCode).toBe(200);

      // Verify status is now enabled
      const statusAfterEnable = await app.inject({
        method: 'GET',
        url: '/api/auth/totp/status',
        headers: authHeaders1,
      });
      expect(statusAfterEnable.json<TotpStatusResponse>()).toEqual({
        enabled: true,
        remainingRecoveryCodes: 8,
      });

      // 6. Log out
      await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: authHeaders1,
      });

      // 7. Attempt login with password alone -> receives 2FA required prompt, NO session
      const promptRes = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          username: 'admin',
          password: 'AdminPassword123!',
        },
      });
      expect(promptRes.statusCode).toBe(200);
      expect(promptRes.json()).toEqual({
        message: 'Two-factor authentication code required',
        totpRequired: true,
      });
      const promptCookies = promptRes.headers['set-cookie'];
      expect(parseCookie(promptCookies, SESSION_COOKIE_NAME)).toBeUndefined();

      // 8. Attempt login with wrong TOTP code -> 401
      const failCodeRes = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          username: 'admin',
          password: 'AdminPassword123!',
          totpCode: '999999',
        },
      });
      expect(failCodeRes.statusCode).toBe(401);
      expect(failCodeRes.json()).toMatchObject({
        error: 'Unauthorized',
        message: 'Invalid two-factor authentication code',
      });

      // 9. Login with valid TOTP code -> 200 and session established
      const loginCode = generateTotp(setupData.secret);
      const successLoginRes = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          username: 'admin',
          password: 'AdminPassword123!',
          totpCode: loginCode,
        },
      });
      expect(successLoginRes.statusCode).toBe(200);
      const loginCookies = successLoginRes.headers['set-cookie'];
      const session2 = parseCookie(loginCookies, SESSION_COOKIE_NAME);
      const csrf2 = parseCookie(loginCookies, CSRF_COOKIE_NAME);
      expect(session2).toBeDefined();

      const authHeaders2 = {
        cookie: `${SESSION_COOKIE_NAME}=${session2}; ${CSRF_COOKIE_NAME}=${csrf2}`,
        [CSRF_HEADER_NAME]: csrf2 ?? '',
      };

      // Verify auth status shows user with totpEnabled: true
      const authStatus = await app.inject({
        method: 'GET',
        url: '/api/auth/status',
        headers: authHeaders2,
      });
      expect(authStatus.json<AuthStatusResponse>().user?.totpEnabled).toBe(
        true,
      );

      // 10. Log out
      await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: authHeaders2,
      });

      // 11. Login with a recovery code
      const usedRecoveryCode = setupData.recoveryCodes[0]!;
      const recoveryLoginRes = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          username: 'admin',
          password: 'AdminPassword123!',
          recoveryCode: usedRecoveryCode,
        },
      });
      expect(recoveryLoginRes.statusCode).toBe(200);
      expect(recoveryLoginRes.json()).toMatchObject({
        message: 'Logged in successfully with recovery code',
      });
      const recoveryCookies = recoveryLoginRes.headers['set-cookie'];
      const session3 = parseCookie(recoveryCookies, SESSION_COOKIE_NAME);
      const csrf3 = parseCookie(recoveryCookies, CSRF_COOKIE_NAME);

      const authHeaders3 = {
        cookie: `${SESSION_COOKIE_NAME}=${session3}; ${CSRF_COOKIE_NAME}=${csrf3}`,
        [CSRF_HEADER_NAME]: csrf3 ?? '',
      };

      // Verify remaining recovery codes is now 7
      const statusAfterRecovery = await app.inject({
        method: 'GET',
        url: '/api/auth/totp/status',
        headers: authHeaders3,
      });
      expect(
        statusAfterRecovery.json<TotpStatusResponse>().remainingRecoveryCodes,
      ).toBe(7);

      // 12. Attempt to reuse the same recovery code -> 401
      const reuseRecoveryRes = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          username: 'admin',
          password: 'AdminPassword123!',
          recoveryCode: usedRecoveryCode,
        },
      });
      expect(reuseRecoveryRes.statusCode).toBe(401);
      expect(reuseRecoveryRes.json()).toMatchObject({
        error: 'Unauthorized',
        message: 'Invalid recovery code',
      });

      // 13. Regenerate recovery codes
      const regenRes = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/recovery-codes',
        headers: authHeaders3,
        payload: { password: 'AdminPassword123!' },
      });
      expect(regenRes.statusCode).toBe(200);
      const newRecoveryCodes = regenRes.json<{ recoveryCodes: string[] }>()
        .recoveryCodes;
      expect(newRecoveryCodes).toHaveLength(8);

      const statusAfterRegen = await app.inject({
        method: 'GET',
        url: '/api/auth/totp/status',
        headers: authHeaders3,
      });
      expect(
        statusAfterRegen.json<TotpStatusResponse>().remainingRecoveryCodes,
      ).toBe(8);

      // 14. Disable 2FA with password
      const disableRes = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/disable',
        headers: authHeaders3,
        payload: { password: 'AdminPassword123!' },
      });
      expect(disableRes.statusCode).toBe(200);

      // Log out and verify password-alone login works again directly
      await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: authHeaders3,
      });
      const directLoginRes = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          username: 'admin',
          password: 'AdminPassword123!',
        },
      });
      expect(directLoginRes.statusCode).toBe(200);
      expect(directLoginRes.json()).toMatchObject({
        message: 'Logged in successfully',
      });

      // 15. Admin reset 2FA flow on another user
      const adminLoginCookies = directLoginRes.headers['set-cookie'];
      const sessionAdmin = parseCookie(adminLoginCookies, SESSION_COOKIE_NAME);
      const csrfAdmin = parseCookie(adminLoginCookies, CSRF_COOKIE_NAME);
      const adminHeaders = {
        cookie: `${SESSION_COOKIE_NAME}=${sessionAdmin}; ${CSRF_COOKIE_NAME}=${csrfAdmin}`,
        [CSRF_HEADER_NAME]: csrfAdmin ?? '',
      };

      // Create operator user
      const createOpRes = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: adminHeaders,
        payload: {
          username: 'operator-totp',
          password: 'OperatorPassword123!',
          role: 'operator',
        },
      });
      expect(createOpRes.statusCode).toBe(201);
      const operatorId = createOpRes.json<{ id: string }>().id;

      // Operator logs in and enables 2FA
      const opLoginRes = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          username: 'operator-totp',
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

      const opSetup = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/setup',
        headers: opHeaders,
      });
      const opSecret = opSetup.json<TotpSetupResponse>().secret;
      await app.inject({
        method: 'POST',
        url: '/api/auth/totp/enable',
        headers: opHeaders,
        payload: { code: generateTotp(opSecret) },
      });

      // Admin resets operator's 2FA
      const resetRes = await app.inject({
        method: 'POST',
        url: `/api/users/${operatorId}/totp/reset`,
        headers: adminHeaders,
      });
      expect(resetRes.statusCode).toBe(200);
      expect(resetRes.json()).toEqual({
        message: 'Two-factor authentication reset successfully',
      });

      // Operator can now log in without TOTP
      const opDirectLogin = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          username: 'operator-totp',
          password: 'OperatorPassword123!',
        },
      });
      expect(opDirectLogin.statusCode).toBe(200);
      expect(opDirectLogin.json()).toMatchObject({
        message: 'Logged in successfully',
      });
    } finally {
      handle.close();
    }
  });

  it('enforces validation and edge cases on TOTP endpoints', async () => {
    const handle = createDatabase({ path: ':memory:' });
    try {
      const repos = createSqliteRepositories(handle.db);
      const app = await buildApp({ config, repositories: repos });

      // Unauthenticated attempts
      expect(
        (await app.inject({ method: 'GET', url: '/api/auth/totp/status' }))
          .statusCode,
      ).toBe(401);
      expect(
        (await app.inject({ method: 'POST', url: '/api/auth/totp/setup' }))
          .statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/auth/totp/enable',
            payload: { code: '123456' },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/auth/totp/disable',
            payload: { password: 'pwd' },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/auth/totp/recovery-codes',
            payload: { password: 'pwd' },
          })
        ).statusCode,
      ).toBe(401);

      // Create admin
      const setupRes = await app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        payload: { username: 'edge-admin', password: 'EdgeAdminPassword123!' },
      });
      const setupCookies = setupRes.headers['set-cookie'];
      const session = parseCookie(setupCookies, SESSION_COOKIE_NAME);
      const csrf = parseCookie(setupCookies, CSRF_COOKIE_NAME);
      const authHeaders = {
        cookie: `${SESSION_COOKIE_NAME}=${session}; ${CSRF_COOKIE_NAME}=${csrf}`,
        [CSRF_HEADER_NAME]: csrf ?? '',
      };

      // Enable without setup initiated
      const enableWithoutSetup = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/enable',
        headers: authHeaders,
        payload: { code: '123456' },
      });
      expect(enableWithoutSetup.statusCode).toBe(400);

      // Regenerate recovery codes when not enabled
      const regenNotEnabled = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/recovery-codes',
        headers: authHeaders,
        payload: { password: 'EdgeAdminPassword123!' },
      });
      expect(regenNotEnabled.statusCode).toBe(400);

      // Reset non-existent user
      const resetMissing = await app.inject({
        method: 'POST',
        url: '/api/users/non-existent-user/totp/reset',
        headers: authHeaders,
      });
      expect(resetMissing.statusCode).toBe(404);

      // Setup TOTP then try regen recovery codes with wrong password
      await app.inject({
        method: 'POST',
        url: '/api/auth/totp/setup',
        headers: authHeaders,
      });

      // Enable properly
      const user = await repos.users.getByUsername('edge-admin');
      const { decryptSecret, resolveAppKey } = await import('./encryption.js');
      const plainSecret = decryptSecret(
        user!.totpSecret!,
        resolveAppKey(config),
      );
      await app.inject({
        method: 'POST',
        url: '/api/auth/totp/enable',
        headers: authHeaders,
        payload: { code: generateTotp(plainSecret) },
      });

      // Try regen recovery codes with wrong password
      const regenWrongPwd = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/recovery-codes',
        headers: authHeaders,
        payload: { password: 'WrongPassword!' },
      });
      expect(regenWrongPwd.statusCode).toBe(400);

      // Try disable with wrong password
      const disableWrongPwd = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/disable',
        headers: authHeaders,
        payload: { password: 'WrongPassword!' },
      });
      expect(disableWrongPwd.statusCode).toBe(400);
    } finally {
      handle.close();
    }
  });
});

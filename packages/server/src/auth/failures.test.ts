import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import {
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, createSqliteRepositories } from '../db/index.js';
import { loadConfig } from '../config.js';
import { authModule } from './module.js';
import { SessionService } from './session.js';
import { LoginRateLimiter } from './rate-limit.js';
import { hashPassword } from './password.js';
import { encryptSecret, resolveAppKey } from './encryption.js';

const config = loadConfig({
  HACM_DATA_DIR: '/fixture-data',
  HACM_STATE_DIR: '/fixture-state',
  HACM_SECRET_KEY: 'fixture-encryption-key'.padEnd(32, 'x'),
  HACM_COOKIE_SECURE: 'false',
});
const headers = {
  cookie: 'hacm_session=fixture-session; hacm_csrf=fixture-csrf',
  'x-csrf-token': 'fixture-csrf',
};
let database: ReturnType<typeof createDatabase>;
let repos: ReturnType<typeof createSqliteRepositories>;
let app: FastifyInstance;
beforeEach(async () => {
  database = createDatabase({ path: ':memory:' });
  repos = createSqliteRepositories(database.db);
  await repos.users.create({
    id: 'fixture-user',
    username: 'fixture-user',
    passwordHash: await hashPassword('fixture-password'),
    role: 'admin',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await repos.sessions.create({
    id: 'fixture-session',
    userId: 'fixture-user',
    createdAt: new Date(),
    lastSeenAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  });
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(cookie);
  await authModule(app, {
    config,
    repos,
    sessionService: new SessionService(repos, config),
    rateLimiter: new LoginRateLimiter({ maxFailures: 2 }),
  });
});
afterEach(async () => {
  await app.close();
  database.close();
  vi.restoreAllMocks();
});

describe('authentication API error paths', () => {
  it('supplies default authentication services and rejects an unauthenticated private route', async () => {
    const standalone = Fastify();
    standalone.setValidatorCompiler(validatorCompiler);
    standalone.setSerializerCompiler(serializerCompiler);
    await standalone.register(cookie);
    await authModule(standalone, { config, repos });
    try {
      expect(
        (await standalone.inject({ url: '/api/auth/totp/status' })).statusCode,
      ).toBe(401);
    } finally {
      await standalone.close();
    }
  });
  it('returns no user for a stale public session and rejects an unknown login', async () => {
    const status = await app.inject({
      url: '/api/auth/status',
      headers: { cookie: 'hacm_session=absent' },
    });
    expect(status.json().user).toBeNull();
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'absent', password: 'fixture-password' },
    });
    expect(login.statusCode).toBe(401);
  });

  it.each([
    { cookie: 'hacm_session=fixture-session', 'x-csrf-token': 'fixture-csrf' },
    { ...headers, 'x-csrf-token': 'wrong' },
  ])('rejects missing or mismatched CSRF cookies', async (invalidHeaders) => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/logout',
          headers: invalidHeaders,
        })
      ).statusCode,
    ).toBe(403);
  });

  it.each([null, 'invalid-encrypted-fixture'])(
    'rejects login with a missing or corrupt TOTP secret',
    async (secret) => {
      await repos.users.setTotpEnabled('fixture-user', true);
      await repos.users.setTotpSecret('fixture-user', secret);
      const result = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          username: 'fixture-user',
          password: 'fixture-password',
          totpCode: '123456',
        },
      });
      expect(result.statusCode).toBe(401);
      expect(result.json().message).toContain(secret ? 'decrypt' : 'missing');
    },
  );

  it.each(['totpCode', 'recoveryCode'])(
    'locks repeated invalid %s attempts',
    async (field) => {
      await repos.users.setTotpEnabled('fixture-user', true);
      await repos.users.setTotpSecret(
        'fixture-user',
        encryptSecret('GEZDGNBVGY3TQOJQ', resolveAppKey(config)),
      );
      for (const expected of [401, 429]) {
        const result = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: {
            username: 'fixture-user',
            password: 'fixture-password',
            [field]: 'invalid-fixture-code',
          },
        });
        expect(result.statusCode).toBe(expected);
      }
    },
  );

  it.each([null, 'invalid-encrypted-fixture'])(
    'rejects enabling TOTP before a valid enrollment',
    async (secret) => {
      await repos.users.setTotpSecret('fixture-user', secret);
      const result = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/enable',
        headers,
        payload: { code: '123456' },
      });
      expect(result.statusCode).toBe(400);
      expect(result.json().message).toContain(
        secret ? 'decrypt' : 'not initiated',
      );
    },
  );

  it('rejects incorrect current passwords and recovery regeneration while TOTP is disabled', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/password',
          headers,
          payload: {
            currentPassword: 'wrong',
            newPassword: 'fixture-new-password',
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/totp/recovery-codes',
          headers,
          payload: { password: 'fixture-password' },
        })
      ).statusCode,
    ).toBe(400);
    await repos.users.setTotpEnabled('fixture-user', true);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/totp/recovery-codes',
          headers,
          payload: { password: 'wrong' },
        })
      ).statusCode,
    ).toBe(400);
  });

  it.each([
    {
      url: '/api/auth/password',
      payload: {
        currentPassword: 'fixture-password',
        newPassword: 'new-fixture-password',
      },
    },
    {
      url: '/api/auth/totp/disable',
      payload: { password: 'fixture-password' },
    },
    {
      url: '/api/auth/totp/recovery-codes',
      payload: { password: 'fixture-password' },
    },
  ])(
    'refuses $url if the user disappears between authentication and mutation',
    async ({ url, payload }) => {
      const owner = await repos.users.getById('fixture-user');
      vi.spyOn(repos.users, 'getById')
        .mockResolvedValueOnce(owner)
        .mockResolvedValueOnce(null);
      const result = await app.inject({
        method: 'POST',
        url,
        headers,
        payload,
      });
      expect(result.statusCode).toBe(401);
      expect(result.json().message).toBe('User not found');
    },
  );
});

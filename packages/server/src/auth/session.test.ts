import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, createSqliteRepositories } from '../db/index.js';
import { loadConfig } from '../config.js';
import {
  SessionService,
  SESSION_ABSOLUTE_TIMEOUT_MS,
  SESSION_IDLE_TIMEOUT_MS,
} from './session.js';

const config = loadConfig({
  HACM_DATA_DIR: '/fixture-data',
  HACM_STATE_DIR: '/fixture-state',
  HACM_COOKIE_SECURE: 'true',
});
let database: ReturnType<typeof createDatabase>;
let repos: ReturnType<typeof createSqliteRepositories>;
let service: SessionService;
const request = (id?: string) =>
  ({ cookies: id ? { hacm_session: id } : {}, headers: {} }) as FastifyRequest;
const response = () =>
  ({ setCookie: vi.fn(), clearCookie: vi.fn() }) as unknown as FastifyReply;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  database = createDatabase({ path: ':memory:' });
  repos = createSqliteRepositories(database.db);
  service = new SessionService(repos, config);
});
afterEach(() => {
  database.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function user() {
  return repos.users.create({
    id: 'fixture-user',
    username: 'fixture-user',
    passwordHash: 'fake-hash',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

describe('session expiration and revocation', () => {
  it('sets secure cookies, persists missing request metadata as null, and slides idle expiry', async () => {
    const reply = response();
    const session = await service.createSession(await user(), request(), reply);
    expect(session.ipAddress).toBeNull();
    expect(session.userAgent).toBeNull();
    expect(reply.setCookie).toHaveBeenCalledWith(
      'hacm_session',
      session.id,
      expect.objectContaining({ secure: true, httpOnly: true }),
    );
    vi.advanceTimersByTime(SESSION_IDLE_TIMEOUT_MS - 1000);
    expect(await service.authenticate(request(session.id))).not.toBeNull();
    const updated = await repos.sessions.get(session.id);
    expect(updated?.expiresAt.getTime()).toBe(
      Date.now() + SESSION_IDLE_TIMEOUT_MS,
    );
    vi.advanceTimersByTime(2000);
    expect(await service.authenticate(request(session.id))).not.toBeNull();
  });

  it.each(['idle', 'absolute'] as const)(
    'removes sessions after the %s timeout',
    async (kind) => {
      const owner = await user();
      await repos.sessions.create({
        id: 'fixture-session',
        userId: owner.id,
        createdAt: new Date(
          Date.now() -
            (kind === 'absolute' ? SESSION_ABSOLUTE_TIMEOUT_MS + 1 : 1000),
        ),
        expiresAt: new Date(Date.now() + (kind === 'idle' ? -1 : 1000)),
        lastSeenAt: new Date(),
      });
      expect(await service.authenticate(request('fixture-session'))).toBeNull();
      expect(await repos.sessions.get('fixture-session')).toBeNull();
    },
  );

  it('rejects missing sessions and sessions whose owner no longer exists', async () => {
    expect(await service.authenticate(request())).toBeNull();
    expect(await service.authenticate(request('missing'))).toBeNull();
    const session = await service.createSession(
      await user(),
      request(),
      response(),
    );
    vi.spyOn(repos.users, 'getById').mockResolvedValue(null);
    expect(await service.authenticate(request(session.id))).toBeNull();
    expect(await repos.sessions.get(session.id)).toBeNull();
  });

  it('revokes individual or all user sessions and clears cookies when a response is supplied', async () => {
    const owner = await user();
    const first = await service.createSession(owner, request(), response());
    await service.createSession(owner, request(), response());
    const reply = response();
    await service.destroySession(request(first.id), reply);
    expect(await repos.sessions.get(first.id)).toBeNull();
    await service.destroySession(request(), reply);
    expect(await service.destroyAllUserSessions(owner.id, reply)).toBe(1);
    expect(await service.destroyAllUserSessions(owner.id)).toBe(0);
    expect(reply.clearCookie).toHaveBeenCalledWith('hacm_csrf', { path: '/' });
  });
});

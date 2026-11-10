import { afterEach, describe, expect, it, vi } from 'vitest';
import { globalSecretRedactor } from '@hacm/core';
import { createDatabase, createSqliteRepositories } from '../db/index.js';
import { ApiTokenService, apiTokenInternals } from './api-token.js';

function fixture(role = 'admin') {
  const database = createDatabase({ path: ':memory:' });
  const repos = createSqliteRepositories(database.db);
  const now = new Date('2026-11-10T10:00:00.000Z');
  const user = {
    id: 'user-1',
    username: 'fixture',
    passwordHash: 'fake-hash',
    role,
    autoGrantNewHosts: false,
    totpSecret: null,
    totpEnabled: false,
    createdAt: now,
    updatedAt: now,
  };
  return { database, repos, now, user };
}

afterEach(() => {
  globalSecretRedactor.clear();
  vi.restoreAllMocks();
});

describe('ApiTokenService', () => {
  it('creates a high-entropy token, stores only its hash, and authenticates with a capped role', async () => {
    const test = fixture();
    await test.repos.users.create(test.user);
    let current = test.now;
    const service = new ApiTokenService(test.repos, () => current);
    const created = await service.create({
      user: test.user,
      name: 'fixture automation',
      scope: 'operator',
    });
    expect(created.token).toMatch(apiTokenInternals.TOKEN_PATTERN);
    expect(created.item).toMatchObject({
      name: 'fixture automation',
      scope: 'operator',
    });
    expect(created.item.prefix).toContain('hacm_pat_');
    const [row] = await test.repos.apiTokens.listByUser(test.user.id);
    expect(row?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(row)).not.toContain(created.token);
    expect(globalSecretRedactor.redact(created.token)).toBe('***');

    const updateLastUsed = vi.spyOn(test.repos.apiTokens, 'updateLastUsed');
    await expect(
      service.authenticate(`Bearer ${created.token}`),
    ).resolves.toMatchObject({
      status: 'authenticated',
      user: { role: 'operator', username: 'fixture' },
    });
    expect(updateLastUsed).toHaveBeenCalledOnce();
    await service.authenticate(`Bearer ${created.token}`);
    expect(updateLastUsed).toHaveBeenCalledOnce();

    current = new Date(test.now.getTime() + 5 * 60_000);
    await service.authenticate(`Bearer ${created.token}`);
    expect(updateLastUsed).toHaveBeenCalledTimes(2);
    await test.repos.users.updateRole(test.user.id, 'viewer');
    await expect(
      service.authenticate(`Bearer ${created.token}`),
    ).resolves.toMatchObject({
      status: 'authenticated',
      user: { role: 'viewer' },
    });
    expect(await service.list(test.user.id)).toHaveLength(1);
    expect(await service.revoke(created.item.id, test.user.id)).toBe(true);
    await expect(
      service.authenticate(`Bearer ${created.token}`),
    ).resolves.toEqual({ status: 'invalid' });
    test.database.close();
  });

  it('rejects excessive scopes, malformed tokens, tampering, expiry, and unknown roles', async () => {
    const test = fixture('operator');
    await test.repos.users.create(test.user);
    let current = test.now;
    const service = new ApiTokenService(test.repos, () => current);
    expect(service.scopesFor('operator')).toEqual(['viewer', 'operator']);
    expect(service.scopesFor('unknown')).toEqual([]);
    await expect(
      service.create({ user: test.user, name: 'bad', scope: 'admin' }),
    ).rejects.toThrow('exceeds user role');
    const created = await service.create({
      user: test.user,
      name: 'expiring',
      scope: 'viewer',
      expiresAt: new Date(test.now.getTime() + 1000),
    });
    await expect(service.authenticate(undefined)).resolves.toEqual({
      status: 'absent',
    });
    for (const header of [
      'Basic abc',
      'Bearer malformed',
      `Bearer ${created.token.slice(0, -1)}${created.token.endsWith('a') ? 'b' : 'a'}`,
    ]) {
      await expect(service.authenticate(header)).resolves.toEqual({
        status: 'invalid',
      });
    }
    current = new Date(test.now.getTime() + 1001);
    await expect(
      service.authenticate(`Bearer ${created.token}`),
    ).resolves.toEqual({ status: 'invalid' });

    current = test.now;
    const other = await service.create({
      user: test.user,
      name: 'unknown role',
      scope: 'viewer',
    });
    await test.repos.users.updateRole(test.user.id, 'unknown');
    await expect(
      service.authenticate(`Bearer ${other.token}`),
    ).resolves.toEqual({ status: 'invalid' });
    expect(apiTokenInternals.hashesMatch('aa', 'bbbb')).toBe(false);
    expect(apiTokenInternals.effectiveRole('admin', 'viewer')).toBe('viewer');
    expect(apiTokenInternals.effectiveRole('bad', 'viewer')).toBeNull();
    test.database.close();
  });
});

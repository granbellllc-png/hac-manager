import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { apiTokensTable } from './schema.js';
import { createDatabase } from './connection.js';
import { createSqliteRepositories } from './repositories/sqlite.js';

describe('API token repository', () => {
  it('defines the user foreign key and persists token lifecycle metadata', async () => {
    expect(getTableConfig(apiTokensTable).foreignKeys).toHaveLength(1);
    const database = createDatabase({ path: ':memory:' });
    const repos = createSqliteRepositories(database.db);
    try {
      const now = new Date('2026-11-10T10:00:00.000Z');
      await repos.users.create({
        id: 'user-1',
        username: 'fixture',
        passwordHash: 'fake-hash',
        role: 'operator',
        autoGrantNewHosts: false,
        createdAt: now,
        updatedAt: now,
      });
      const created = await repos.apiTokens.create({
        id: 'token-1',
        userId: 'user-1',
        lookupId: 'lookup-fixture-1',
        name: 'automation',
        tokenHash: 'a'.repeat(64),
        scope: 'operator',
        createdAt: now,
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
      });
      expect(created.tokenHash).toBe('a'.repeat(64));
      expect(await repos.apiTokens.getByLookupId('lookup-fixture-1')).toEqual(
        created,
      );
      expect(await repos.apiTokens.getByLookupId('missing')).toBeNull();
      expect(await repos.apiTokens.listByUser('user-1')).toEqual([created]);
      const usedAt = new Date('2026-11-10T10:05:00.000Z');
      expect(await repos.apiTokens.updateLastUsed('token-1', usedAt)).toBe(
        true,
      );
      expect(await repos.apiTokens.updateLastUsed('missing')).toBe(false);
      expect(
        (await repos.apiTokens.getByLookupId('lookup-fixture-1'))?.lastUsedAt,
      ).toEqual(usedAt);
      const revokedAt = new Date('2026-11-10T10:10:00.000Z');
      expect(await repos.apiTokens.revoke('token-1', 'user-1', revokedAt)).toBe(
        true,
      );
      expect(await repos.apiTokens.revoke('token-1', 'user-1')).toBe(false);
      expect(await repos.apiTokens.revoke('token-1', 'other')).toBe(false);
      expect(
        (await repos.apiTokens.getByLookupId('lookup-fixture-1'))?.revokedAt,
      ).toEqual(revokedAt);
    } finally {
      database.close();
    }
  });
});

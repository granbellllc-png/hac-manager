import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import {
  createDatabase,
  createSqliteRepositories,
  runMigrations,
} from './index.js';
import { totpMigration } from './migrator.js';
import {
  sessionsTable,
  recoveryCodesTable,
  userHostAccessTable,
} from './schema.js';

describe('database migrations and boundary operations', () => {
  it('upgrades a pre-TOTP users table and remains idempotent', () => {
    const database = createDatabase({
      path: ':memory:',
      migrate: false,
      busyTimeout: 100,
    });
    try {
      database.sqlite.exec('CREATE TABLE users (id TEXT PRIMARY KEY)');
      expect(runMigrations(database.sqlite, [totpMigration])).toEqual([
        '0002_totp_2fa',
      ]);
      const columns = database.sqlite.pragma('table_info(users)') as {
        name: string;
      }[];
      expect(columns.map((column) => column.name)).toEqual([
        'id',
        'totp_secret',
        'totp_enabled',
      ]);
      expect(runMigrations(database.sqlite, [totpMigration])).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('declares cascading user ownership consistently in the ORM metadata', () => {
    for (const table of [
      sessionsTable,
      recoveryCodesTable,
      userHostAccessTable,
    ]) {
      const foreignKey = getTableConfig(table).foreignKeys[0]!;
      expect(foreignKey.onDelete).toBe('cascade');
      expect(foreignKey.reference().foreignColumns[0]?.name).toBe('id');
    }
  });

  it('replaces host grants, filters audit timestamps, and cleans expired sessions', async () => {
    const database = createDatabase({ path: ':memory:' });
    try {
      const repos = createSqliteRepositories(database.db);
      const now = new Date();
      await repos.users.create({
        id: 'fixture',
        username: 'fixture',
        passwordHash: 'fake',
        createdAt: now,
        updatedAt: now,
      });
      await repos.userHostAccess.setGrantedHosts('fixture', ['alpha', 'beta']);
      await repos.userHostAccess.setGrantedHosts('fixture', ['beta']);
      expect(await repos.userHostAccess.getGrantedHostIds('fixture')).toEqual([
        'beta',
      ]);
      expect(await repos.users.updateRole('fixture', 'operator')).toBe(true);
      await repos.auditLogs.append({
        id: 'fixture-audit',
        username: 'fixture',
        action: 'fixture.read',
        reason: 'manual',
        createdAt: now,
      });
      expect(
        (
          await repos.auditLogs.search({
            username: 'fixture',
            from: now.getTime(),
            to: now.getTime(),
            order: 'asc',
          })
        ).total,
      ).toBe(1);
      expect(
        (await repos.auditLogs.search({ from: now, to: now, hostIds: [] }))
          .total,
      ).toBe(1);
      expect(await repos.auditLogs.getById('missing')).toBeNull();
      expect(await repos.auditLogs.getById('fixture-audit')).toMatchObject({
        action: 'fixture.read',
      });
      await repos.sessions.create({
        id: 'fixture-session',
        userId: 'fixture',
        createdAt: now,
        lastSeenAt: now,
        expiresAt: new Date(0),
      });
      expect(await repos.sessions.deleteExpired()).toBe(1);
    } finally {
      database.close();
    }
  });
});

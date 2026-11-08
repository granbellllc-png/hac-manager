import { eq, lte, and } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../schema.js';
import type {
  DatabaseRepositories,
  SettingsRepository,
  HostsCacheRepository,
  SessionsRepository,
} from './types.js';

export function createSqliteRepositories(
  db: BetterSQLite3Database<typeof schema>,
): DatabaseRepositories {
  const settings: SettingsRepository = {
    async get(key: string) {
      const row = db
        .select()
        .from(schema.settingsTable)
        .where(eq(schema.settingsTable.key, key))
        .get();
      return row ? row.value : null;
    },
    async set(key: string, value: string) {
      const now = new Date();
      db.insert(schema.settingsTable)
        .values({ key, value, updatedAt: now })
        .onConflictDoUpdate({
          target: schema.settingsTable.key,
          set: { value, updatedAt: now },
        })
        .run();
    },
    async delete(key: string) {
      const result = db
        .delete(schema.settingsTable)
        .where(eq(schema.settingsTable.key, key))
        .run();
      return result.changes > 0;
    },
    async list() {
      return db.select().from(schema.settingsTable).all();
    },
  };

  const hostsCache: HostsCacheRepository = {
    async get(id: string) {
      const row = db
        .select()
        .from(schema.hostsCacheTable)
        .where(eq(schema.hostsCacheTable.id, id))
        .get();
      return row ?? null;
    },
    async upsert(row) {
      db.insert(schema.hostsCacheTable)
        .values(row)
        .onConflictDoUpdate({
          target: schema.hostsCacheTable.id,
          set: {
            name: row.name,
            type: row.type,
            status: row.status,
            lastSeenAt: row.lastSeenAt,
            cachedConfigJson: row.cachedConfigJson,
            updatedAt: row.updatedAt,
          },
        })
        .run();
    },
    async delete(id: string) {
      const result = db
        .delete(schema.hostsCacheTable)
        .where(eq(schema.hostsCacheTable.id, id))
        .run();
      return result.changes > 0;
    },
    async list() {
      return db.select().from(schema.hostsCacheTable).all();
    },
  };

  const users = {
    async getById(id: string) {
      const row = db
        .select()
        .from(schema.usersTable)
        .where(eq(schema.usersTable.id, id))
        .get();
      return row ?? null;
    },
    async getByUsername(username: string) {
      const row = db
        .select()
        .from(schema.usersTable)
        .where(eq(schema.usersTable.username, username))
        .get();
      return row ?? null;
    },
    async create(row: schema.InsertUserRow) {
      db.insert(schema.usersTable).values(row).run();
      const created = db
        .select()
        .from(schema.usersTable)
        .where(eq(schema.usersTable.id, row.id))
        .get();
      if (!created) {
        throw new Error(`Failed to create user with id ${row.id}`);
      }
      return created;
    },
    async updateRole(id: string, role: string, autoGrantNewHosts?: boolean) {
      const updateData: {
        role: string;
        updatedAt: Date;
        autoGrantNewHosts?: boolean;
      } = {
        role,
        updatedAt: new Date(),
      };
      if (autoGrantNewHosts !== undefined) {
        updateData.autoGrantNewHosts = autoGrantNewHosts;
      }
      const result = db
        .update(schema.usersTable)
        .set(updateData)
        .where(eq(schema.usersTable.id, id))
        .run();
      return result.changes > 0;
    },
    async updatePassword(id: string, passwordHash: string) {
      const result = db
        .update(schema.usersTable)
        .set({ passwordHash, updatedAt: new Date() })
        .where(eq(schema.usersTable.id, id))
        .run();
      return result.changes > 0;
    },
    async count() {
      const rows = db.select().from(schema.usersTable).all();
      return rows.length;
    },
    async list() {
      return db.select().from(schema.usersTable).all();
    },
    async delete(id: string) {
      const result = db
        .delete(schema.usersTable)
        .where(eq(schema.usersTable.id, id))
        .run();
      return result.changes > 0;
    },
  };

  const userHostAccess = {
    async getGrantedHostIds(userId: string) {
      const rows = db
        .select()
        .from(schema.userHostAccessTable)
        .where(eq(schema.userHostAccessTable.userId, userId))
        .all();
      return rows.map((r) => r.hostId);
    },
    async grant(userId: string, hostId: string) {
      const now = new Date();
      db.insert(schema.userHostAccessTable)
        .values({ userId, hostId, grantedAt: now })
        .onConflictDoNothing()
        .run();
    },
    async revoke(userId: string, hostId: string) {
      const result = db
        .delete(schema.userHostAccessTable)
        .where(
          and(
            eq(schema.userHostAccessTable.userId, userId),
            eq(schema.userHostAccessTable.hostId, hostId),
          ),
        )
        .run();
      return result.changes > 0;
    },
    async setGrantedHosts(userId: string, hostIds: readonly string[]) {
      const now = new Date();
      db.transaction(() => {
        db.delete(schema.userHostAccessTable)
          .where(eq(schema.userHostAccessTable.userId, userId))
          .run();
        for (const hostId of hostIds) {
          db.insert(schema.userHostAccessTable)
            .values({ userId, hostId, grantedAt: now })
            .run();
        }
      });
    },
    async hasAccess(userId: string, hostId: string) {
      const row = db
        .select()
        .from(schema.userHostAccessTable)
        .where(
          and(
            eq(schema.userHostAccessTable.userId, userId),
            eq(schema.userHostAccessTable.hostId, hostId),
          ),
        )
        .get();
      return !!row;
    },
    async autoGrantHostToEligibleUsers(hostId: string) {
      const eligibleUsers = db
        .select()
        .from(schema.usersTable)
        .where(eq(schema.usersTable.autoGrantNewHosts, true))
        .all();
      const now = new Date();
      let grantedCount = 0;
      for (const u of eligibleUsers) {
        const result = db
          .insert(schema.userHostAccessTable)
          .values({ userId: u.id, hostId, grantedAt: now })
          .onConflictDoNothing()
          .run();
        if (result.changes > 0) grantedCount++;
      }
      return grantedCount;
    },
  };

  const sessions: SessionsRepository = {
    async get(id: string) {
      const row = db
        .select()
        .from(schema.sessionsTable)
        .where(eq(schema.sessionsTable.id, id))
        .get();
      return row ?? null;
    },
    async create(row) {
      db.insert(schema.sessionsTable).values(row).run();
    },
    async updateLastSeen(id: string, lastSeenAt: Date) {
      db.update(schema.sessionsTable)
        .set({ lastSeenAt })
        .where(eq(schema.sessionsTable.id, id))
        .run();
    },
    async delete(id: string) {
      const result = db
        .delete(schema.sessionsTable)
        .where(eq(schema.sessionsTable.id, id))
        .run();
      return result.changes > 0;
    },
    async deleteExpired(now: Date = new Date()) {
      const result = db
        .delete(schema.sessionsTable)
        .where(lte(schema.sessionsTable.expiresAt, now))
        .run();
      return result.changes;
    },
    async deleteByUserId(userId: string) {
      const result = db
        .delete(schema.sessionsTable)
        .where(eq(schema.sessionsTable.userId, userId))
        .run();
      return result.changes;
    },
  };

  return {
    settings,
    hostsCache,
    users,
    userHostAccess,
    sessions,
  };
}

import { eq, lte } from 'drizzle-orm';
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
    sessions,
  };
}

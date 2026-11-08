import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const settingsTable = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const hostsCacheTable = sqliteTable('hosts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  status: text('status').notNull().default('unknown'),
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }),
  cachedConfigJson: text('cached_config_json').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const sessionsTable = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
});

export const migrationsTable = sqliteTable('__hacm_migrations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  appliedAt: integer('applied_at', { mode: 'timestamp_ms' }).notNull(),
});

export type SettingRow = typeof settingsTable.$inferSelect;
export type InsertSettingRow = typeof settingsTable.$inferInsert;

export type HostCacheRow = typeof hostsCacheTable.$inferSelect;
export type InsertHostCacheRow = typeof hostsCacheTable.$inferInsert;

export type SessionRow = typeof sessionsTable.$inferSelect;
export type InsertSessionRow = typeof sessionsTable.$inferInsert;

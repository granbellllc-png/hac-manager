import { eq, lte, gte, and, isNull, inArray, desc, asc } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { randomUUID } from 'node:crypto';
import { sanitizeAuditPayload } from '@hacm/core';
import * as schema from '../schema.js';
import { verifyRecoveryCodeMatch } from '../../auth/totp.js';
import type {
  DatabaseRepositories,
  SettingsRepository,
  HostsCacheRepository,
  RecoveryCodesRepository,
  AuditLogsRepository,
  CreateAuditInput,
  AuditFilter,
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
    async setTotpSecret(id: string, totpSecret: string | null) {
      const result = db
        .update(schema.usersTable)
        .set({ totpSecret, updatedAt: new Date() })
        .where(eq(schema.usersTable.id, id))
        .run();
      return result.changes > 0;
    },
    async setTotpEnabled(id: string, enabled: boolean) {
      const result = db
        .update(schema.usersTable)
        .set({ totpEnabled: enabled, updatedAt: new Date() })
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

  const recoveryCodes: RecoveryCodesRepository = {
    async setCodes(userId: string, codeHashes: readonly string[]) {
      db.transaction((tx) => {
        tx.delete(schema.recoveryCodesTable)
          .where(eq(schema.recoveryCodesTable.userId, userId))
          .run();
        const now = new Date();
        for (const codeHash of codeHashes) {
          tx.insert(schema.recoveryCodesTable)
            .values({
              id: randomUUID(),
              userId,
              codeHash,
              usedAt: null,
              createdAt: now,
            })
            .run();
        }
      });
    },
    async listByUser(userId: string) {
      return db
        .select()
        .from(schema.recoveryCodesTable)
        .where(eq(schema.recoveryCodesTable.userId, userId))
        .all();
    },
    async useCode(userId: string, rawCode: string) {
      const unusedCodes = db
        .select()
        .from(schema.recoveryCodesTable)
        .where(
          and(
            eq(schema.recoveryCodesTable.userId, userId),
            isNull(schema.recoveryCodesTable.usedAt),
          ),
        )
        .all();

      for (const record of unusedCodes) {
        if (verifyRecoveryCodeMatch(rawCode, record.codeHash)) {
          const result = db
            .update(schema.recoveryCodesTable)
            .set({ usedAt: new Date() })
            .where(eq(schema.recoveryCodesTable.id, record.id))
            .run();
          return result.changes > 0;
        }
      }
      return false;
    },
    async countRemaining(userId: string) {
      const unused = db
        .select()
        .from(schema.recoveryCodesTable)
        .where(
          and(
            eq(schema.recoveryCodesTable.userId, userId),
            isNull(schema.recoveryCodesTable.usedAt),
          ),
        )
        .all();
      return unused.length;
    },
    async deleteByUser(userId: string) {
      const result = db
        .delete(schema.recoveryCodesTable)
        .where(eq(schema.recoveryCodesTable.userId, userId))
        .run();
      return result.changes;
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
    async updateLastSeen(id: string, lastSeenAt: Date, expiresAt?: Date) {
      db.update(schema.sessionsTable)
        .set({ lastSeenAt, expiresAt })
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

  const auditLogs: AuditLogsRepository = {
    async append(input: CreateAuditInput) {
      const now = input.createdAt ?? new Date();
      const id = input.id ?? randomUUID();

      const sanitizedDiff =
        input.diff !== undefined ? sanitizeAuditPayload(input.diff) : undefined;
      const sanitizedMeta =
        input.metadata !== undefined
          ? sanitizeAuditPayload(input.metadata)
          : undefined;

      const diffJson =
        sanitizedDiff !== undefined ? JSON.stringify(sanitizedDiff) : null;
      const metadataJson =
        sanitizedMeta !== undefined ? JSON.stringify(sanitizedMeta) : null;

      const row: schema.InsertAuditLogRow = {
        id,
        userId: input.userId ?? null,
        username: input.username ?? null,
        hostId: input.hostId ?? null,
        vmid: input.vmid ?? null,
        action: input.action,
        reason: input.reason,
        jobId: input.jobId ?? null,
        diffJson,
        metadataJson,
        createdAt: now,
      };

      db.insert(schema.auditLogsTable).values(row).run();
      return row as schema.AuditLogRow;
    },
    async getById(id: string) {
      const row = db
        .select()
        .from(schema.auditLogsTable)
        .where(eq(schema.auditLogsTable.id, id))
        .get();
      return row ?? null;
    },
    async search(filter: AuditFilter) {
      const conditions = [];

      if (filter.userId) {
        conditions.push(eq(schema.auditLogsTable.userId, filter.userId));
      }
      if (filter.username) {
        conditions.push(eq(schema.auditLogsTable.username, filter.username));
      }
      if (filter.hostId) {
        conditions.push(eq(schema.auditLogsTable.hostId, filter.hostId));
      } else if (filter.hostIds && filter.hostIds.length > 0) {
        conditions.push(
          inArray(schema.auditLogsTable.hostId, filter.hostIds as string[]),
        );
      }
      if (filter.vmid !== undefined) {
        conditions.push(eq(schema.auditLogsTable.vmid, filter.vmid));
      }
      if (filter.action) {
        conditions.push(eq(schema.auditLogsTable.action, filter.action));
      }
      if (filter.reason) {
        conditions.push(eq(schema.auditLogsTable.reason, filter.reason));
      }
      if (filter.from !== undefined) {
        const fromDate =
          typeof filter.from === 'number' ? new Date(filter.from) : filter.from;
        conditions.push(gte(schema.auditLogsTable.createdAt, fromDate));
      }
      if (filter.to !== undefined) {
        const toDate =
          typeof filter.to === 'number' ? new Date(filter.to) : filter.to;
        conditions.push(lte(schema.auditLogsTable.createdAt, toDate));
      }

      const whereClause =
        conditions.length > 0 ? and(...conditions) : undefined;

      const totalRows = db
        .select()
        .from(schema.auditLogsTable)
        .where(whereClause)
        .all();
      const total = totalRows.length;

      const orderFn = filter.order === 'asc' ? asc : desc;
      const limit = filter.limit ?? 50;
      const offset = filter.offset ?? 0;

      const items = db
        .select()
        .from(schema.auditLogsTable)
        .where(whereClause)
        .orderBy(orderFn(schema.auditLogsTable.createdAt))
        .limit(limit)
        .offset(offset)
        .all();

      return {
        items,
        total,
      };
    },
  };

  return {
    settings,
    hostsCache,
    users,
    userHostAccess,
    recoveryCodes,
    auditLogs,
    sessions,
  };
}

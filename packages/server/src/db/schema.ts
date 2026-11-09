import {
  sqliteTable,
  text,
  integer,
  index,
  primaryKey,
} from 'drizzle-orm/sqlite-core';

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

export const usersTable = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('viewer'),
  autoGrantNewHosts: integer('auto_grant_new_hosts', { mode: 'boolean' })
    .notNull()
    .default(false),
  totpSecret: text('totp_secret'),
  totpEnabled: integer('totp_enabled', { mode: 'boolean' })
    .notNull()
    .default(false),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const recoveryCodesTable = sqliteTable('recovery_codes', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => usersTable.id, { onDelete: 'cascade' }),
  codeHash: text('code_hash').notNull(),
  usedAt: integer('used_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const userHostAccessTable = sqliteTable('user_host_access', {
  userId: text('user_id')
    .notNull()
    .references(() => usersTable.id, { onDelete: 'cascade' }),
  hostId: text('host_id').notNull(),
  grantedAt: integer('granted_at', { mode: 'timestamp_ms' }).notNull(),
});

export const sessionsTable = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => usersTable.id, { onDelete: 'cascade' }),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
});

export const auditLogsTable = sqliteTable('audit_logs', {
  id: text('id').primaryKey(),
  userId: text('user_id'),
  username: text('username'),
  hostId: text('host_id'),
  vmid: integer('vmid'),
  action: text('action').notNull(),
  reason: text('reason', {
    enum: [
      'manual',
      'drift_push',
      'drift_pull',
      'schedule',
      'conflict_resolution',
      'orphan_action',
    ],
  }).notNull(),
  jobId: text('job_id'),
  diffJson: text('diff_json'),
  metadataJson: text('metadata_json'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const jobsTable = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    hostId: text('host_id').notNull(),
    vmid: integer('vmid'),
    lane: text('lane', { enum: ['guest', 'host'] }).notNull(),
    type: text('type').notNull(),
    status: text('status', {
      enum: [
        'queued',
        'running',
        'waiting_input',
        'completed',
        'failed',
        'cancelled',
        'interrupted',
      ],
    }).notNull(),
    priority: integer('priority').notNull().default(0),
    payloadJson: text('payload_json'),
    triggeredBy: text('triggered_by'),
    dependsOnJobId: text('depends_on_job_id'),
    timeoutMs: integer('timeout_ms'),
    cancelRequestedAt: integer('cancel_requested_at', {
      mode: 'timestamp_ms',
    }),
    error: text('error'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    index('idx_jobs_status_priority').on(table.status, table.priority),
    index('idx_jobs_host_status').on(table.hostId, table.status),
    index('idx_jobs_guest_status').on(table.hostId, table.vmid, table.status),
    index('idx_jobs_dependency').on(table.dependsOnJobId),
  ],
);

export const jobLogLinesTable = sqliteTable(
  'job_log_lines',
  {
    jobId: text('job_id')
      .notNull()
      .references(() => jobsTable.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    ts: integer('ts', { mode: 'timestamp_ms' }).notNull(),
    stream: text('stream', {
      enum: ['stdout', 'stderr', 'system'],
    }).notNull(),
    text: text('text').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.jobId, table.seq] }),
    index('idx_job_log_lines_job_ts').on(table.jobId, table.ts),
  ],
);

export const jobStepsTable = sqliteTable(
  'job_steps',
  {
    jobId: text('job_id')
      .notNull()
      .references(() => jobsTable.id, { onDelete: 'cascade' }),
    stepIndex: integer('step_index').notNull(),
    name: text('name').notNull(),
    status: text('status', {
      enum: ['pending', 'running', 'completed', 'failed', 'skipped'],
    }).notNull(),
    resultJson: text('result_json'),
    rollbackHint: text('rollback_hint'),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
  },
  (table) => [primaryKey({ columns: [table.jobId, table.stepIndex] })],
);

export const promptsTable = sqliteTable(
  'prompts',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobsTable.id, { onDelete: 'cascade' }),
    kind: text('kind', {
      enum: ['choice', 'confirm', 'typed_confirmation'],
    }).notNull(),
    status: text('status', {
      enum: ['pending', 'resolved', 'expired'],
    }).notNull(),
    message: text('message').notNull(),
    payloadJson: text('payload_json'),
    optionsJson: text('options_json'),
    expectedText: text('expected_text'),
    resolutionJson: text('resolution_json'),
    resolvedBy: text('resolved_by'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    resolvedAt: integer('resolved_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    index('idx_prompts_job_status').on(table.jobId, table.status),
    index('idx_prompts_status_expiry').on(table.status, table.expiresAt),
  ],
);

export const migrationsTable = sqliteTable('__hacm_migrations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  appliedAt: integer('applied_at', { mode: 'timestamp_ms' }).notNull(),
});

export type SettingRow = typeof settingsTable.$inferSelect;
export type InsertSettingRow = typeof settingsTable.$inferInsert;

export type HostCacheRow = typeof hostsCacheTable.$inferSelect;
export type InsertHostCacheRow = typeof hostsCacheTable.$inferInsert;

export type UserRow = typeof usersTable.$inferSelect;
export type InsertUserRow = typeof usersTable.$inferInsert;

export type UserHostAccessRow = typeof userHostAccessTable.$inferSelect;
export type InsertUserHostAccessRow = typeof userHostAccessTable.$inferInsert;

export type RecoveryCodeRow = typeof recoveryCodesTable.$inferSelect;
export type InsertRecoveryCodeRow = typeof recoveryCodesTable.$inferInsert;

export type AuditLogRow = typeof auditLogsTable.$inferSelect;
export type InsertAuditLogRow = typeof auditLogsTable.$inferInsert;

export type SessionRow = typeof sessionsTable.$inferSelect;
export type InsertSessionRow = typeof sessionsTable.$inferInsert;

export type JobRow = typeof jobsTable.$inferSelect;
export type InsertJobRow = typeof jobsTable.$inferInsert;

export type JobLogLineRow = typeof jobLogLinesTable.$inferSelect;
export type InsertJobLogLineRow = typeof jobLogLinesTable.$inferInsert;

export type JobStepRow = typeof jobStepsTable.$inferSelect;
export type InsertJobStepRow = typeof jobStepsTable.$inferInsert;

export type PromptRow = typeof promptsTable.$inferSelect;
export type InsertPromptRow = typeof promptsTable.$inferInsert;

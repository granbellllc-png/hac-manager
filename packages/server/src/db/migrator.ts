import type Database from 'better-sqlite3';

export interface Migration {
  readonly id: string;
  readonly up: (db: Database.Database) => void | Promise<void>;
  readonly down?: (db: Database.Database) => void | Promise<void>;
}

export const initialMigration: Migration = {
  id: '0001_initial_schema',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS hosts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unknown',
        last_seen_at INTEGER,
        cached_config_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'viewer',
        auto_grant_new_hosts INTEGER NOT NULL DEFAULT 0,
        totp_secret TEXT,
        totp_enabled INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS recovery_codes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash TEXT NOT NULL,
        used_at INTEGER,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        username TEXT,
        host_id TEXT,
        vmid INTEGER,
        action TEXT NOT NULL,
        reason TEXT NOT NULL,
        job_id TEXT,
        diff_json TEXT,
        metadata_json TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_host_access (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        host_id TEXT NOT NULL,
        granted_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, host_id)
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        ip_address TEXT,
        user_agent TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
      CREATE INDEX IF NOT EXISTS idx_user_host_access_user_id ON user_host_access(user_id);
      CREATE INDEX IF NOT EXISTS idx_user_host_access_host_id ON user_host_access(host_id);
      CREATE INDEX IF NOT EXISTS idx_recovery_codes_user_id ON recovery_codes(user_id);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_host_id ON audit_logs(host_id);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_vmid ON audit_logs(vmid);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_reason ON audit_logs(reason);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
    `);
  },
};

export const totpMigration: Migration = {
  id: '0002_totp_2fa',
  up: (db) => {
    // Check if columns exist before adding (in case 0001 created them)
    const columns = db.pragma('table_info(users)') as { name: string }[];
    const columnNames = new Set(columns.map((c) => c.name));

    if (!columnNames.has('totp_secret')) {
      db.exec('ALTER TABLE users ADD COLUMN totp_secret TEXT;');
    }
    if (!columnNames.has('totp_enabled')) {
      db.exec(
        'ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;',
      );
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS recovery_codes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash TEXT NOT NULL,
        used_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_recovery_codes_user_id ON recovery_codes(user_id);
    `);
  },
};

export const auditLogsMigration: Migration = {
  id: '0003_audit_logs',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        username TEXT,
        host_id TEXT,
        vmid INTEGER,
        action TEXT NOT NULL,
        reason TEXT NOT NULL,
        job_id TEXT,
        diff_json TEXT,
        metadata_json TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_host_id ON audit_logs(host_id);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_vmid ON audit_logs(vmid);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_reason ON audit_logs(reason);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
    `);
  },
};

export const jobsQueueMigration: Migration = {
  id: '0004_jobs_queue',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        host_id TEXT NOT NULL,
        vmid INTEGER,
        lane TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        payload_json TEXT,
        triggered_by TEXT,
        depends_on_job_id TEXT,
        timeout_ms INTEGER,
        cancel_requested_at INTEGER,
        error TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS job_log_lines (
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        stream TEXT NOT NULL,
        text TEXT NOT NULL,
        PRIMARY KEY (job_id, seq)
      );

      CREATE TABLE IF NOT EXISTS job_steps (
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        step_index INTEGER NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT,
        rollback_hint TEXT,
        started_at INTEGER,
        finished_at INTEGER,
        PRIMARY KEY (job_id, step_index)
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_status_priority
        ON jobs(status, priority DESC, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_jobs_host_status
        ON jobs(host_id, status);
      CREATE INDEX IF NOT EXISTS idx_jobs_guest_status
        ON jobs(host_id, vmid, status);
      CREATE INDEX IF NOT EXISTS idx_jobs_dependency
        ON jobs(depends_on_job_id);
      CREATE INDEX IF NOT EXISTS idx_job_log_lines_job_ts
        ON job_log_lines(job_id, ts);
    `);
  },
};

export const promptsMigration: Migration = {
  id: '0005_prompts',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS prompts (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT NOT NULL,
        payload_json TEXT,
        options_json TEXT,
        expected_text TEXT,
        resolution_json TEXT,
        resolved_by TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        resolved_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_prompts_job_status
        ON prompts(job_id, status);
      CREATE INDEX IF NOT EXISTS idx_prompts_status_expiry
        ON prompts(status, expires_at);
    `);
  },
};

export const allMigrations: readonly Migration[] = [
  initialMigration,
  totpMigration,
  auditLogsMigration,
  jobsQueueMigration,
  promptsMigration,
];

export function runMigrations(
  sqlite: Database.Database,
  migrations: readonly Migration[] = allMigrations,
): readonly string[] {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS __hacm_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL
    );
  `);

  const appliedRows = sqlite
    .prepare('SELECT name FROM __hacm_migrations')
    .all() as { name: string }[];
  const appliedNames = new Set(appliedRows.map((r) => r.name));

  const newlyApplied: string[] = [];

  for (const migration of migrations) {
    if (!appliedNames.has(migration.id)) {
      sqlite.transaction(() => {
        migration.up(sqlite);
        sqlite
          .prepare(
            'INSERT INTO __hacm_migrations (name, applied_at) VALUES (?, ?)',
          )
          .run(migration.id, Date.now());
      })();
      newlyApplied.push(migration.id);
    }
  }

  return newlyApplied;
}

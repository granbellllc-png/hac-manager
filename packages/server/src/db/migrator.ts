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

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        ip_address TEXT,
        user_agent TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
    `);
  },
};

export const allMigrations: readonly Migration[] = [initialMigration];

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

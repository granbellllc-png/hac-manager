import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import {
  drizzle,
  type BetterSQLite3Database,
} from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import { runMigrations, type Migration } from './migrator.js';

export interface DatabaseOptions {
  /** File path for SQLite database, or ':memory:' for tests */
  readonly path: string;
  /** Busy timeout in milliseconds (default: 5000) */
  readonly busyTimeout?: number | undefined;
  /** Whether to run migrations on open (default: true) */
  readonly migrate?: boolean | undefined;
  /** Custom migration list (optional, defaults to built-in migrations) */
  readonly migrations?: readonly Migration[] | undefined;
}

export interface DatabaseHandle {
  readonly sqlite: Database.Database;
  readonly db: BetterSQLite3Database<typeof schema>;
  readonly close: () => void;
}

export function createDatabase(options: DatabaseOptions): DatabaseHandle {
  const { path, busyTimeout = 5000, migrate = true, migrations } = options;

  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }

  const sqlite = new Database(path);

  // WAL mode for concurrency and performance
  if (path !== ':memory:') {
    sqlite.pragma('journal_mode = WAL');
  }

  // Busy timeout to avoid immediate lock errors
  sqlite.pragma(`busy_timeout = ${busyTimeout}`);

  // Enforce foreign key constraints
  sqlite.pragma('foreign_keys = ON');

  if (migrate) {
    runMigrations(sqlite, migrations);
  }

  const db = drizzle(sqlite, { schema });

  return {
    sqlite,
    db,
    close: () => {
      sqlite.close();
    },
  };
}

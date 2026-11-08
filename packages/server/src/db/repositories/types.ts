import type {
  SettingRow,
  HostCacheRow,
  InsertHostCacheRow,
  SessionRow,
  InsertSessionRow,
} from '../schema.js';

export interface SettingsRepository {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<boolean>;
  list(): Promise<readonly SettingRow[]>;
}

export interface HostsCacheRepository {
  get(id: string): Promise<HostCacheRow | null>;
  upsert(row: InsertHostCacheRow): Promise<void>;
  delete(id: string): Promise<boolean>;
  list(): Promise<readonly HostCacheRow[]>;
}

export interface SessionsRepository {
  get(id: string): Promise<SessionRow | null>;
  create(row: InsertSessionRow): Promise<void>;
  updateLastSeen(id: string, lastSeenAt: Date): Promise<void>;
  delete(id: string): Promise<boolean>;
  deleteExpired(now?: Date): Promise<number>;
  deleteByUserId(userId: string): Promise<number>;
}

export interface DatabaseRepositories {
  readonly settings: SettingsRepository;
  readonly hostsCache: HostsCacheRepository;
  readonly sessions: SessionsRepository;
}

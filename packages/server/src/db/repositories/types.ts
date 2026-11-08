import type {
  SettingRow,
  HostCacheRow,
  InsertHostCacheRow,
  UserRow,
  InsertUserRow,
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

export interface UsersRepository {
  getById(id: string): Promise<UserRow | null>;
  getByUsername(username: string): Promise<UserRow | null>;
  create(row: InsertUserRow): Promise<UserRow>;
  updateRole(
    id: string,
    role: string,
    autoGrantNewHosts?: boolean,
  ): Promise<boolean>;
  updatePassword(id: string, passwordHash: string): Promise<boolean>;
  count(): Promise<number>;
  list(): Promise<readonly UserRow[]>;
  delete(id: string): Promise<boolean>;
}

export interface UserHostAccessRepository {
  getGrantedHostIds(userId: string): Promise<readonly string[]>;
  grant(userId: string, hostId: string): Promise<void>;
  revoke(userId: string, hostId: string): Promise<boolean>;
  setGrantedHosts(userId: string, hostIds: readonly string[]): Promise<void>;
  hasAccess(userId: string, hostId: string): Promise<boolean>;
  autoGrantHostToEligibleUsers(hostId: string): Promise<number>;
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
  readonly users: UsersRepository;
  readonly userHostAccess: UserHostAccessRepository;
  readonly sessions: SessionsRepository;
}

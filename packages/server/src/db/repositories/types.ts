import type {
  SettingRow,
  HostCacheRow,
  InsertHostCacheRow,
  UserRow,
  InsertUserRow,
  SessionRow,
  InsertSessionRow,
  RecoveryCodeRow,
  AuditLogRow,
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
  setTotpSecret(id: string, totpSecret: string | null): Promise<boolean>;
  setTotpEnabled(id: string, enabled: boolean): Promise<boolean>;
  count(): Promise<number>;
  list(): Promise<readonly UserRow[]>;
  delete(id: string): Promise<boolean>;
}

export interface RecoveryCodesRepository {
  setCodes(userId: string, codeHashes: readonly string[]): Promise<void>;
  listByUser(userId: string): Promise<readonly RecoveryCodeRow[]>;
  useCode(userId: string, rawCode: string): Promise<boolean>;
  countRemaining(userId: string): Promise<number>;
  deleteByUser(userId: string): Promise<number>;
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

export type AuditReason =
  | 'manual'
  | 'drift_push'
  | 'drift_pull'
  | 'schedule'
  | 'conflict_resolution'
  | 'orphan_action';

export interface CreateAuditInput {
  readonly id?: string | undefined;
  readonly userId?: string | null | undefined;
  readonly username?: string | null | undefined;
  readonly hostId?: string | null | undefined;
  readonly vmid?: number | null | undefined;
  readonly action: string;
  readonly reason: AuditReason;
  readonly jobId?: string | null | undefined;
  readonly diff?: unknown;
  readonly metadata?: unknown;
  readonly createdAt?: Date | undefined;
}

export interface AuditFilter {
  readonly userId?: string | undefined;
  readonly username?: string | undefined;
  readonly hostId?: string | undefined;
  readonly hostIds?: readonly string[] | undefined;
  readonly vmid?: number | undefined;
  readonly action?: string | undefined;
  readonly reason?: AuditReason | undefined;
  readonly from?: Date | number | undefined;
  readonly to?: Date | number | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
  readonly order?: 'asc' | 'desc' | undefined;
}

export interface AuditSearchResult {
  readonly items: readonly AuditLogRow[];
  readonly total: number;
}

export interface AuditLogsRepository {
  append(input: CreateAuditInput): Promise<AuditLogRow>;
  search(filter: AuditFilter): Promise<AuditSearchResult>;
  getById(id: string): Promise<AuditLogRow | null>;
}

export interface DatabaseRepositories {
  readonly settings: SettingsRepository;
  readonly hostsCache: HostsCacheRepository;
  readonly users: UsersRepository;
  readonly userHostAccess: UserHostAccessRepository;
  readonly recoveryCodes: RecoveryCodesRepository;
  readonly auditLogs: AuditLogsRepository;
  readonly sessions: SessionsRepository;
}

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
  JobRow,
  InsertJobRow,
  JobLogLineRow,
  JobStepRow,
  InsertJobStepRow,
  PromptRow,
  InsertPromptRow,
  PlanRow,
  InsertPlanRow,
  DriftSnapshotRow,
  InsertDriftSnapshotRow,
  ApiTokenRow,
  InsertApiTokenRow,
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
  updateLastSeen(id: string, lastSeenAt: Date, expiresAt?: Date): Promise<void>;
  delete(id: string): Promise<boolean>;
  deleteExpired(now?: Date): Promise<number>;
  deleteByUserId(userId: string): Promise<number>;
}

export interface ApiTokensRepository {
  create(row: InsertApiTokenRow): Promise<ApiTokenRow>;
  getByLookupId(lookupId: string): Promise<ApiTokenRow | null>;
  listByUser(userId: string): Promise<readonly ApiTokenRow[]>;
  updateLastUsed(id: string, lastUsedAt?: Date): Promise<boolean>;
  revoke(id: string, userId: string, revokedAt?: Date): Promise<boolean>;
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

export type JobStatus = JobRow['status'];
export type JobLogStream = JobLogLineRow['stream'];

export interface JobStatusPatch {
  readonly startedAt?: Date | null | undefined;
  readonly finishedAt?: Date | null | undefined;
  readonly cancelRequestedAt?: Date | null | undefined;
  readonly error?: string | null | undefined;
}

export interface JobListFilter {
  readonly hostId?: string | undefined;
  readonly vmid?: number | undefined;
  readonly statuses?: readonly JobStatus[] | undefined;
  readonly limit?: number | undefined;
}

export interface JobsRepository {
  create(row: InsertJobRow): Promise<JobRow>;
  get(id: string): Promise<JobRow | null>;
  list(filter?: JobListFilter): Promise<readonly JobRow[]>;
  claim(id: string, startedAt?: Date): Promise<JobRow | null>;
  updateStatus(
    id: string,
    status: JobStatus,
    patch?: JobStatusPatch,
  ): Promise<boolean>;
  requestCancel(id: string, requestedAt?: Date): Promise<boolean>;
  interruptRunning(interruptedAt?: Date): Promise<number>;
}

export interface AppendJobLogLineInput {
  readonly jobId: string;
  readonly stream: JobLogStream;
  readonly text: string;
  readonly ts?: Date | undefined;
}

export interface JobLogLinesRepository {
  append(input: AppendJobLogLineInput): Promise<JobLogLineRow>;
  list(
    jobId: string,
    options?: {
      readonly afterSeq?: number | undefined;
      readonly limit?: number | undefined;
    },
  ): Promise<readonly JobLogLineRow[]>;
}

export interface JobStepsRepository {
  upsert(row: InsertJobStepRow): Promise<JobStepRow>;
  list(jobId: string): Promise<readonly JobStepRow[]>;
}

export interface PromptListFilter {
  readonly jobId?: string | undefined;
  readonly statuses?: readonly PromptRow['status'][] | undefined;
}

export interface ResolvePromptInput {
  readonly resolutionJson: string;
  readonly resolvedBy: string;
  readonly resolvedAt?: Date | undefined;
}

export interface PromptsRepository {
  create(row: InsertPromptRow): Promise<PromptRow>;
  get(id: string): Promise<PromptRow | null>;
  list(filter?: PromptListFilter): Promise<readonly PromptRow[]>;
  resolve(id: string, input: ResolvePromptInput): Promise<PromptRow | null>;
  expireDue(now?: Date): Promise<number>;
}

export interface PlanListFilter {
  readonly hostId?: string | undefined;
  readonly statuses?: readonly PlanRow['status'][] | undefined;
  readonly limit?: number | undefined;
}

export interface UpdatePlanStatusPatch {
  readonly approvedBy?: string | null | undefined;
  readonly lastJobId?: string | null | undefined;
  readonly error?: string | null | undefined;
  readonly approvedAt?: Date | null | undefined;
  readonly appliedAt?: Date | null | undefined;
}

export interface PlansRepository {
  create(row: InsertPlanRow): Promise<PlanRow>;
  get(id: string): Promise<PlanRow | null>;
  list(filter?: PlanListFilter): Promise<readonly PlanRow[]>;
  claimApply(
    id: string,
    input: {
      readonly jobId: string;
      readonly approvedBy: string;
      readonly approvedAt?: Date | undefined;
    },
  ): Promise<PlanRow | null>;
  updateStatus(
    id: string,
    status: PlanRow['status'],
    patch?: UpdatePlanStatusPatch,
  ): Promise<boolean>;
}

export interface DriftSnapshotListFilter {
  readonly hostId?: string | undefined;
  readonly vmid?: number | undefined;
  readonly statuses?: readonly DriftSnapshotRow['status'][] | undefined;
  readonly limit?: number | undefined;
}

export interface DriftSnapshotsRepository {
  upsert(row: InsertDriftSnapshotRow): Promise<DriftSnapshotRow>;
  get(hostId: string, vmid: number): Promise<DriftSnapshotRow | null>;
  list(filter?: DriftSnapshotListFilter): Promise<readonly DriftSnapshotRow[]>;
  delete(hostId: string, vmid: number): Promise<boolean>;
}

export interface DatabaseRepositories {
  readonly settings: SettingsRepository;
  readonly hostsCache: HostsCacheRepository;
  readonly users: UsersRepository;
  readonly userHostAccess: UserHostAccessRepository;
  readonly recoveryCodes: RecoveryCodesRepository;
  readonly auditLogs: AuditLogsRepository;
  readonly sessions: SessionsRepository;
  readonly apiTokens: ApiTokensRepository;
  readonly jobs: JobsRepository;
  readonly jobLogLines: JobLogLinesRepository;
  readonly jobSteps: JobStepsRepository;
  readonly prompts: PromptsRepository;
  readonly plans: PlansRepository;
  readonly driftSnapshots: DriftSnapshotsRepository;
}

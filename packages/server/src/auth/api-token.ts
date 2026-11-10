import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { globalSecretRedactor } from '@hacm/core';
import type { ApiTokenRow, UserRow } from '../db/schema.js';
import type { DatabaseRepositories } from '../db/repositories/types.js';
import type { AuthenticatedUser } from './session.js';
import type { UserRole } from './policy.js';

const TOKEN_PREFIX = 'hacm_pat';
const TOKEN_PATTERN = /^hacm_pat_([A-Za-z0-9_-]{16})_([A-Za-z0-9_-]{43})$/;
const LAST_USED_WRITE_INTERVAL_MS = 5 * 60_000;

const roleRank: Readonly<Record<UserRole, number>> = {
  viewer: 0,
  operator: 1,
  admin: 2,
};

function isRole(value: string): value is UserRole {
  return value === 'admin' || value === 'operator' || value === 'viewer';
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function hashesMatch(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function effectiveRole(userRole: string, tokenScope: string): UserRole | null {
  if (!isRole(userRole) || !isRole(tokenScope)) return null;
  return roleRank[userRole] <= roleRank[tokenScope] ? userRole : tokenScope;
}

export interface PublicApiToken {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly scope: UserRole;
  readonly createdAt: string;
  readonly expiresAt?: string | undefined;
  readonly lastUsedAt?: string | undefined;
  readonly revokedAt?: string | undefined;
}

export type ApiTokenAuthentication =
  | { readonly status: 'absent' }
  | { readonly status: 'invalid' }
  | {
      readonly status: 'authenticated';
      readonly tokenId: string;
      readonly user: AuthenticatedUser;
    };

function toPublicToken(row: ApiTokenRow): PublicApiToken {
  return {
    id: row.id,
    name: row.name,
    prefix: `${TOKEN_PREFIX}_${row.lookupId.slice(0, 8)}…`,
    scope: row.scope,
    createdAt: row.createdAt.toISOString(),
    ...(row.expiresAt ? { expiresAt: row.expiresAt.toISOString() } : {}),
    ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt.toISOString() } : {}),
    ...(row.revokedAt ? { revokedAt: row.revokedAt.toISOString() } : {}),
  };
}

export class ApiTokenService {
  public constructor(
    private readonly repos: DatabaseRepositories,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public scopesFor(userRole: string): readonly UserRole[] {
    if (!isRole(userRole)) return [];
    return (['viewer', 'operator', 'admin'] as const).filter(
      (scope) => roleRank[scope] <= roleRank[userRole],
    );
  }

  public async create(input: {
    readonly user: UserRow;
    readonly name: string;
    readonly scope: UserRole;
    readonly expiresAt?: Date | undefined;
  }): Promise<{ readonly token: string; readonly item: PublicApiToken }> {
    if (!this.scopesFor(input.user.role).includes(input.scope)) {
      throw new Error(
        `Token scope '${input.scope}' exceeds user role '${input.user.role}'`,
      );
    }
    const lookupId = randomBytes(12).toString('base64url');
    const secret = randomBytes(32).toString('base64url');
    const token = `${TOKEN_PREFIX}_${lookupId}_${secret}`;
    globalSecretRedactor.register(token);
    const row = await this.repos.apiTokens.create({
      id: randomUUID(),
      userId: input.user.id,
      lookupId,
      name: input.name,
      tokenHash: hashToken(token),
      scope: input.scope,
      createdAt: this.now(),
      expiresAt: input.expiresAt ?? null,
      lastUsedAt: null,
      revokedAt: null,
    });
    return { token, item: toPublicToken(row) };
  }

  public async list(userId: string): Promise<readonly PublicApiToken[]> {
    return (await this.repos.apiTokens.listByUser(userId)).map(toPublicToken);
  }

  public async revoke(id: string, userId: string): Promise<boolean> {
    return this.repos.apiTokens.revoke(id, userId, this.now());
  }

  public async authenticate(
    authorization: string | undefined,
  ): Promise<ApiTokenAuthentication> {
    if (!authorization) return { status: 'absent' };
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (!match) return { status: 'invalid' };
    const rawToken = match[1]!.trim();
    const tokenMatch = rawToken.match(TOKEN_PATTERN);
    if (!tokenMatch) return { status: 'invalid' };
    globalSecretRedactor.register(rawToken);
    const row = await this.repos.apiTokens.getByLookupId(tokenMatch[1]!);
    const now = this.now();
    if (
      !row ||
      row.revokedAt ||
      (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) ||
      !hashesMatch(row.tokenHash, hashToken(rawToken))
    ) {
      return { status: 'invalid' };
    }
    const user = await this.repos.users.getById(row.userId);
    if (!user) return { status: 'invalid' };
    const role = effectiveRole(user.role, row.scope);
    if (!role) return { status: 'invalid' };
    if (
      !row.lastUsedAt ||
      now.getTime() - row.lastUsedAt.getTime() >= LAST_USED_WRITE_INTERVAL_MS
    ) {
      await this.repos.apiTokens.updateLastUsed(row.id, now);
    }
    return {
      status: 'authenticated',
      tokenId: row.id,
      user: {
        id: user.id,
        username: user.username,
        role,
        autoGrantNewHosts: user.autoGrantNewHosts,
        totpEnabled: user.totpEnabled,
      },
    };
  }
}

export const apiTokenInternals = {
  hashToken,
  hashesMatch,
  effectiveRole,
  toPublicToken,
  TOKEN_PATTERN,
};

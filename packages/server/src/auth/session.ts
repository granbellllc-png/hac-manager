import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { DatabaseRepositories } from '../db/repositories/types.js';
import type { UserRow, SessionRow } from '../db/schema.js';
import type { ServerConfig } from '../config.js';

export const SESSION_COOKIE_NAME = 'hacm_session';
export const CSRF_HEADER_NAME = 'x-csrf-token';
export const CSRF_COOKIE_NAME = 'hacm_csrf';

// Default idle timeout: 2 hours; absolute timeout: 24 hours
export const SESSION_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export interface AuthenticatedUser {
  readonly id: string;
  readonly username: string;
  readonly role: string;
  readonly autoGrantNewHosts: boolean;
  readonly totpEnabled?: boolean;
}

export interface SessionContext {
  readonly session: SessionRow;
  readonly user: AuthenticatedUser;
}

export class SessionService {
  constructor(
    private readonly repos: DatabaseRepositories,
    private readonly config: ServerConfig,
  ) {}

  async createSession(
    user: UserRow,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<SessionRow> {
    const sessionId = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_IDLE_TIMEOUT_MS);

    const session: SessionRow = {
      id: sessionId,
      userId: user.id,
      expiresAt,
      createdAt: now,
      lastSeenAt: now,
      ipAddress: request.ip ?? null,
      userAgent: (request.headers['user-agent'] as string) ?? null,
    };

    await this.repos.sessions.create(session);

    // Set secure session cookie
    reply.setCookie(SESSION_COOKIE_NAME, sessionId, {
      path: '/',
      httpOnly: true,
      secure: this.config.HACM_COOKIE_SECURE,
      sameSite: 'lax',
      expires: new Date(now.getTime() + SESSION_ABSOLUTE_TIMEOUT_MS),
    });

    // Generate CSRF token for mutating requests
    const csrfToken = randomBytes(24).toString('hex');
    reply.setCookie(CSRF_COOKIE_NAME, csrfToken, {
      path: '/',
      httpOnly: false, // Accessible to SPA client to attach in X-CSRF-Token header
      secure: this.config.HACM_COOKIE_SECURE,
      sameSite: 'lax',
    });

    return session;
  }

  async authenticate(request: FastifyRequest): Promise<SessionContext | null> {
    const sessionId = request.cookies[SESSION_COOKIE_NAME];
    if (!sessionId) {
      return null;
    }

    const session = await this.repos.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    const now = new Date();

    // Check expiration (idle timeout or absolute timeout)
    const isExpired = session.expiresAt.getTime() <= now.getTime();
    const isPastAbsolute =
      now.getTime() - session.createdAt.getTime() > SESSION_ABSOLUTE_TIMEOUT_MS;

    if (isExpired || isPastAbsolute) {
      await this.repos.sessions.delete(session.id);
      return null;
    }

    const user = await this.repos.users.getById(session.userId);
    if (!user) {
      await this.repos.sessions.delete(session.id);
      return null;
    }

    // Slide idle expiration window
    const newExpiresAt = new Date(now.getTime() + SESSION_IDLE_TIMEOUT_MS);
    await this.repos.sessions.updateLastSeen(session.id, now, newExpiresAt);
    session.lastSeenAt = now;
    session.expiresAt = newExpiresAt;

    return {
      session,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        autoGrantNewHosts: user.autoGrantNewHosts,
        totpEnabled: user.totpEnabled,
      },
    };
  }

  async destroySession(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const sessionId = request.cookies[SESSION_COOKIE_NAME];
    if (sessionId) {
      await this.repos.sessions.delete(sessionId);
    }

    reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    reply.clearCookie(CSRF_COOKIE_NAME, { path: '/' });
  }

  async destroyAllUserSessions(
    userId: string,
    reply?: FastifyReply,
  ): Promise<number> {
    const deleted = await this.repos.sessions.deleteByUserId(userId);
    if (reply) {
      reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
      reply.clearCookie(CSRF_COOKIE_NAME, { path: '/' });
    }
    return deleted;
  }
}

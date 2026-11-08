import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { DatabaseRepositories } from '../../db/repositories/types.js';
import { hashPassword } from '../../auth/password.js';
import { checkPermission } from '../../auth/policy.js';

export interface UsersPluginOptions {
  readonly repos: DatabaseRepositories;
}

export const usersModule: FastifyPluginAsync<UsersPluginOptions> = async (
  fastify,
  options,
) => {
  const { repos } = options;
  const typedFastify = fastify.withTypeProvider<ZodTypeProvider>();

  // Admin authorization guard hook for all user management endpoints
  typedFastify.addHook('onRequest', async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Authentication required',
      });
    }

    const { allowed, reason } = await checkPermission(
      request.user,
      { action: 'manage_users' },
      repos,
    );

    if (!allowed) {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: reason ?? 'Administrator privileges required',
      });
    }
  });

  // GET /api/users: List all users with their granted hosts
  typedFastify.get(
    '/api/users',
    {
      schema: {
        description: 'List all users with roles and host access (Admin only)',
        tags: ['users'],
        response: {
          200: z.array(
            z.object({
              id: z.string(),
              username: z.string(),
              role: z.string(),
              autoGrantNewHosts: z.boolean(),
              grantedHosts: z.array(z.string()),
              createdAt: z.date(),
            }),
          ),
          401: z.object({
            statusCode: z.number(),
            error: z.string(),
            message: z.string(),
          }),
          403: z.object({
            statusCode: z.number(),
            error: z.string(),
            message: z.string(),
          }),
        },
      },
    },
    async () => {
      const users = await repos.users.list();
      const results = [];
      for (const u of users) {
        const grantedHosts = await repos.userHostAccess.getGrantedHostIds(u.id);
        results.push({
          id: u.id,
          username: u.username,
          role: u.role,
          autoGrantNewHosts: u.autoGrantNewHosts,
          grantedHosts: Array.from(grantedHosts),
          createdAt: u.createdAt,
        });
      }
      return results;
    },
  );

  // POST /api/users: Create a new user (admin/operator/viewer) with optional host grants
  typedFastify.post(
    '/api/users',
    {
      schema: {
        description: 'Create a new user with role and host grants (Admin only)',
        tags: ['users'],
        body: z.object({
          username: z.string().trim().min(3).max(64),
          password: z.string().min(8).max(128),
          role: z.enum(['admin', 'operator', 'viewer']),
          autoGrantNewHosts: z.boolean().optional(),
          grantedHosts: z.array(z.string()).optional(),
        }),
        response: {
          201: z.object({
            id: z.string(),
            username: z.string(),
            role: z.string(),
            autoGrantNewHosts: z.boolean(),
            grantedHosts: z.array(z.string()),
          }),
          400: z.object({
            statusCode: z.number(),
            error: z.string(),
            message: z.string(),
          }),
          409: z.object({
            statusCode: z.number(),
            error: z.string(),
            message: z.string(),
          }),
          401: z.object({
            statusCode: z.number(),
            error: z.string(),
            message: z.string(),
          }),
          403: z.object({
            statusCode: z.number(),
            error: z.string(),
            message: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { username, password, role, autoGrantNewHosts, grantedHosts } =
        request.body;

      const existing = await repos.users.getByUsername(username);
      if (existing) {
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: `Username '${username}' is already in use.`,
        });
      }

      const passwordHash = await hashPassword(password);
      const now = new Date();
      const user = await repos.users.create({
        id: randomUUID(),
        username,
        passwordHash,
        role,
        autoGrantNewHosts: autoGrantNewHosts ?? false,
        createdAt: now,
        updatedAt: now,
      });

      if (grantedHosts && grantedHosts.length > 0) {
        await repos.userHostAccess.setGrantedHosts(user.id, grantedHosts);
      }

      const assignedHosts = await repos.userHostAccess.getGrantedHostIds(
        user.id,
      );

      return reply.status(201).send({
        id: user.id,
        username: user.username,
        role: user.role,
        autoGrantNewHosts: user.autoGrantNewHosts,
        grantedHosts: Array.from(assignedHosts),
      });
    },
  );

  // PUT /api/users/:id: Update user role and host access
  typedFastify.put(
    '/api/users/:id',
    {
      schema: {
        description: 'Update user role and host grants (Admin only)',
        tags: ['users'],
        params: z.object({
          id: z.string(),
        }),
        body: z.object({
          role: z.enum(['admin', 'operator', 'viewer']).optional(),
          autoGrantNewHosts: z.boolean().optional(),
          grantedHosts: z.array(z.string()).optional(),
        }),
        response: {
          200: z.object({
            id: z.string(),
            username: z.string(),
            role: z.string(),
            autoGrantNewHosts: z.boolean(),
            grantedHosts: z.array(z.string()),
          }),
          404: z.object({
            statusCode: z.number(),
            error: z.string(),
            message: z.string(),
          }),
          401: z.object({
            statusCode: z.number(),
            error: z.string(),
            message: z.string(),
          }),
          403: z.object({
            statusCode: z.number(),
            error: z.string(),
            message: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { role, autoGrantNewHosts, grantedHosts } = request.body;

      const user = await repos.users.getById(id);
      if (!user) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'User not found',
        });
      }

      if (role !== undefined || autoGrantNewHosts !== undefined) {
        await repos.users.updateRole(id, role ?? user.role, autoGrantNewHosts);
      }

      if (grantedHosts !== undefined) {
        await repos.userHostAccess.setGrantedHosts(id, grantedHosts);
      }

      const updated = (await repos.users.getById(id))!;
      const assignedHosts = await repos.userHostAccess.getGrantedHostIds(id);

      return {
        id: updated.id,
        username: updated.username,
        role: updated.role,
        autoGrantNewHosts: updated.autoGrantNewHosts,
        grantedHosts: Array.from(assignedHosts),
      };
    },
  );

  // DELETE /api/users/:id: Delete user
  typedFastify.delete(
    '/api/users/:id',
    {
      schema: {
        description: 'Delete user and associated sessions/grants (Admin only)',
        tags: ['users'],
        params: z.object({
          id: z.string(),
        }),
        response: {
          200: z.object({
            message: z.string(),
          }),
          400: z.object({
            statusCode: z.number(),
            error: z.string(),
            message: z.string(),
          }),
          404: z.object({
            statusCode: z.number(),
            error: z.string(),
            message: z.string(),
          }),
          401: z.object({
            statusCode: z.number(),
            error: z.string(),
            message: z.string(),
          }),
          403: z.object({
            statusCode: z.number(),
            error: z.string(),
            message: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      if (request.user?.id === id) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Cannot delete the currently logged in administrator',
        });
      }

      const deleted = await repos.users.delete(id);
      if (!deleted) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'User not found',
        });
      }

      return { message: 'User deleted successfully' };
    },
  );
};

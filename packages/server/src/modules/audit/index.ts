import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { DatabaseRepositories } from '../../db/repositories/types.js';

export interface AuditPluginOptions {
  readonly repos: DatabaseRepositories;
}

const auditReasonEnum = z.enum([
  'manual',
  'drift_push',
  'drift_pull',
  'schedule',
  'conflict_resolution',
  'orphan_action',
]);

const auditLogItemSchema = z.object({
  id: z.string(),
  userId: z.string().nullable(),
  username: z.string().nullable(),
  hostId: z.string().nullable(),
  vmid: z.number().nullable(),
  action: z.string(),
  reason: auditReasonEnum,
  jobId: z.string().nullable(),
  diffJson: z.string().nullable(),
  metadataJson: z.string().nullable(),
  createdAt: z.date(),
});

export const auditModule: FastifyPluginAsync<AuditPluginOptions> = async (
  fastify,
  options,
) => {
  const { repos } = options;
  const typedFastify = fastify.withTypeProvider<ZodTypeProvider>();

  // Guard: requires authentication
  typedFastify.addHook('onRequest', async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Authentication required',
      });
    }
  });

  // GET /api/audit: Query audit logs with filters and pagination
  typedFastify.get(
    '/api/audit',
    {
      schema: {
        description:
          'Search audit logs with optional filters and pagination (RBAC scoped)',
        tags: ['audit'],
        querystring: z.object({
          userId: z.string().optional(),
          username: z.string().optional(),
          hostId: z.string().optional(),
          vmid: z.coerce.number().int().optional(),
          action: z.string().optional(),
          reason: auditReasonEnum.optional(),
          from: z.coerce.number().int().optional(),
          to: z.coerce.number().int().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
          offset: z.coerce.number().int().min(0).default(0),
          order: z.enum(['asc', 'desc']).default('desc'),
        }),
        response: {
          200: z.object({
            items: z.array(auditLogItemSchema),
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
          401: z.object({
            statusCode: z.number(),
            error: z.string(),
            message: z.string(),
          }),
        },
      },
    },
    async (request) => {
      const user = request.user!;
      const q = request.query;

      let hostIdsFilter: string[] | undefined;
      const hostIdFilter = q.hostId;

      if (user.role !== 'admin') {
        const granted = await repos.userHostAccess.getGrantedHostIds(user.id);
        const grantedSet = new Set(granted);

        if (hostIdFilter) {
          if (!grantedSet.has(hostIdFilter)) {
            return {
              items: [],
              total: 0,
              limit: q.limit,
              offset: q.offset,
            };
          }
        } else {
          hostIdsFilter = Array.from(granted);
          if (hostIdsFilter.length === 0) {
            return {
              items: [],
              total: 0,
              limit: q.limit,
              offset: q.offset,
            };
          }
        }
      }

      const result = await repos.auditLogs.search({
        userId: q.userId,
        username: q.username,
        hostId: hostIdFilter,
        hostIds: hostIdsFilter,
        vmid: q.vmid,
        action: q.action,
        reason: q.reason,
        from: q.from,
        to: q.to,
        limit: q.limit,
        offset: q.offset,
        order: q.order,
      });

      return {
        items: Array.from(result.items),
        total: result.total,
        limit: q.limit,
        offset: q.offset,
      };
    },
  );

  // GET /api/audit/:id: Get a specific audit log by ID
  typedFastify.get(
    '/api/audit/:id',
    {
      schema: {
        description: 'Get a single audit log entry by ID',
        tags: ['audit'],
        params: z.object({
          id: z.string(),
        }),
        response: {
          200: auditLogItemSchema,
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
          404: z.object({
            statusCode: z.number(),
            error: z.string(),
            message: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const item = await repos.auditLogs.getById(id);

      if (!item) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Audit log entry not found',
        });
      }

      const user = request.user!;
      if (user.role !== 'admin' && item.hostId) {
        const hasAccess = await repos.userHostAccess.hasAccess(
          user.id,
          item.hostId,
        );
        if (!hasAccess) {
          return reply.status(403).send({
            statusCode: 403,
            error: 'Forbidden',
            message: 'Access to host audit records denied',
          });
        }
      }

      return item;
    },
  );
};

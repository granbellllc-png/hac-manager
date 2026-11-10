import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { HostRegistry } from '../../hosts/registry.js';
import type { StorageResolution } from '@hacm/core';
import {
  StorageGuestNotFoundError,
  StorageInvariantJobError,
  type StorageInvariantService,
} from '../../storage/index.js';
import { errorSchema, jobSchema, publicJob } from '../plans/index.js';

export interface StorageModuleOptions {
  readonly storageInvariantService: StorageInvariantService;
  readonly hostRegistry: HostRegistry;
}

const forbiddenSchema = errorSchema;
const notFoundSchema = errorSchema;
const conflictSchema = errorSchema;

const resolutionSchema = z.enum(['keep-host-data', 'migrate-rootfs-to-host']);

const guestParams = z.object({
  hostId: z.string(),
  vmid: z.coerce.number().int().positive(),
});

function writableRole(role: string | undefined): boolean {
  return role === 'admin' || role === 'operator';
}

export const storageModule: FastifyPluginAsyncZod<
  StorageModuleOptions
> = async (app, options) => {
  const { storageInvariantService, hostRegistry } = options;

  const canAccessHost = async (
    user: Parameters<HostRegistry['listHosts']>[0],
    hostId: string,
  ): Promise<boolean> => {
    const hosts = await hostRegistry.listHosts(user);
    return hosts.some((host) => host.id === hostId);
  };

  app.post(
    '/api/hosts/:hostId/guests/:vmid/storage/check',
    {
      schema: {
        tags: ['Storage'],
        summary: 'Queue a storage invariant check for one LXC guest',
        params: guestParams,
        response: {
          202: z.object({ job: jobSchema }),
          403: forbiddenSchema,
          404: notFoundSchema,
          409: conflictSchema,
        },
      },
    },
    async (request, reply) => {
      const { hostId, vmid } = request.params;
      if (!writableRole(request.user?.role)) {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Viewer role cannot run storage checks',
        });
      }
      if (!(await canAccessHost(request.user, hostId))) {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: `Access denied to host '${hostId}'`,
        });
      }

      try {
        const job = await storageInvariantService.enqueueCheck({
          hostId,
          vmid,
          ...(request.user?.id ? { triggeredBy: request.user.id } : {}),
        });
        return reply.code(202).send({ job: publicJob(job) });
      } catch (error) {
        if (error instanceof StorageGuestNotFoundError) {
          return reply.code(404).send({
            statusCode: 404,
            error: 'Not Found',
            message: error.message,
          });
        }
        return reply.code(409).send({
          statusCode: 409,
          error: 'Conflict',
          message:
            error instanceof Error
              ? error.message
              : 'Storage invariant check failed',
        });
      }
    },
  );

  app.post(
    '/api/hosts/:hostId/guests/:vmid/storage/resolve',
    {
      schema: {
        tags: ['Storage'],
        summary:
          'Queue a storage resolution that archives the losing side before switching',
        params: guestParams,
        body: z.object({ resolution: resolutionSchema }),
        response: {
          202: z.object({ job: jobSchema }),
          403: forbiddenSchema,
          404: notFoundSchema,
          409: conflictSchema,
        },
      },
    },
    async (request, reply) => {
      const { hostId, vmid } = request.params;
      if (!writableRole(request.user?.role)) {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Viewer role cannot resolve storage conflicts',
        });
      }
      if (!(await canAccessHost(request.user, hostId))) {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: `Access denied to host '${hostId}'`,
        });
      }

      try {
        const job = await storageInvariantService.enqueueResolution({
          hostId,
          vmid,
          resolution: request.body.resolution as StorageResolution,
          ...(request.user?.id ? { triggeredBy: request.user.id } : {}),
        });
        return reply.code(202).send({ job: publicJob(job) });
      } catch (error) {
        if (error instanceof StorageGuestNotFoundError) {
          return reply.code(404).send({
            statusCode: 404,
            error: 'Not Found',
            message: error.message,
          });
        }
        if (error instanceof StorageInvariantJobError) {
          return reply.code(409).send({
            statusCode: 409,
            error: 'Conflict',
            message: error.message,
          });
        }
        return reply.code(409).send({
          statusCode: 409,
          error: 'Conflict',
          message:
            error instanceof Error
              ? error.message
              : 'Storage resolution failed',
        });
      }
    },
  );
};

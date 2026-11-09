import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { toEditorJsonSchema, WriteConflictError, WriteGuard } from '@hacm/core';
import type { HostRegistry } from '../../hosts/registry.js';
import type { DatabaseRepositories } from '../../db/repositories/types.js';
import {
  getConfiguredGuestFromIndex,
  indexConfiguredGuests,
  parseGuestConfigurationForEditor,
  readGuestConfiguration,
  saveGuestConfiguration,
  type AdminOnlyConfigSurface,
} from '../../inventory/configuration.js';

export interface ConfigEditorModuleOptions {
  readonly hostRegistry: HostRegistry;
  readonly repos: DatabaseRepositories;
}

const configIssueSchema = z.object({
  path: z.string(),
  message: z.string(),
  code: z.string(),
});

const adminOnlySurfaceSchema = z.enum([
  'tasks',
  'cmd',
  'include',
  'installation_url',
]);

const errorSchema = z.object({
  statusCode: z.number(),
  error: z.string(),
  message: z.string(),
  issues: z.array(configIssueSchema).optional(),
  adminOnly: z.array(adminOnlySurfaceSchema).optional(),
});

const guestParamsSchema = z.object({
  hostId: z.string(),
  vmid: z.coerce.number().int(),
});

function mergeAdminOnlySurfaces(
  ...groups: readonly (readonly AdminOnlyConfigSurface[])[]
): readonly AdminOnlyConfigSurface[] {
  return [...new Set(groups.flat())].sort();
}

export const configEditorModule: FastifyPluginAsyncZod<
  ConfigEditorModuleOptions
> = async (app, options) => {
  const { hostRegistry, repos } = options;

  app.get(
    '/api/config/schema/deployment',
    {
      schema: {
        tags: ['Configuration'],
        summary: 'Get the deployment editor JSON Schema',
        response: {
          200: z.object({
            schema: z.record(z.string(), z.unknown()),
          }),
        },
      },
    },
    async () => ({ schema: toEditorJsonSchema('deployment') }),
  );

  app.post(
    '/api/config/guests/:hostId/:vmid/validate',
    {
      schema: {
        tags: ['Configuration'],
        summary: 'Validate proposed guest deployment YAML',
        params: guestParamsSchema,
        body: z.object({ rawYaml: z.string().max(1024 * 1024) }),
        response: {
          200: z.object({
            valid: z.boolean(),
            issues: z.array(configIssueSchema),
            adminOnly: z.array(adminOnlySurfaceSchema),
            requiresAdmin: z.boolean(),
          }),
          403: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const { hostId, vmid } = request.params;
      const allowedHosts = await hostRegistry.listHosts(request.user);
      if (!allowedHosts.some((host) => host.id === hostId)) {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: `Access denied to host '${hostId}'`,
        });
      }

      const index = await indexConfiguredGuests(hostRegistry.dataDir);
      const guest = getConfiguredGuestFromIndex(index, hostId, vmid);
      if (!guest) {
        return reply.code(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: `Configured guest '${hostId}/${vmid}' was not found`,
        });
      }

      const parsed = parseGuestConfigurationForEditor(request.body.rawYaml, {
        vmid,
        name: guest.name,
        relativePath: guest.relativePath,
      });
      return {
        valid: parsed.ok,
        issues: [...parsed.issues],
        adminOnly: [...parsed.adminOnly],
        requiresAdmin: parsed.adminOnly.length > 0,
      };
    },
  );

  app.put(
    '/api/config/guests/:hostId/:vmid',
    {
      schema: {
        tags: ['Configuration'],
        summary: 'Safely save guest deployment YAML',
        params: guestParamsSchema,
        body: z.object({
          rawYaml: z.string().max(1024 * 1024),
          expectedHash: z.string().regex(/^[0-9a-f]{64}$/),
          dryRun: z.boolean().optional(),
        }),
        response: {
          200: z.object({
            success: z.literal(true),
            dryRun: z.boolean(),
            rawYaml: z.string(),
            hash: z.string(),
            config: z.record(z.string(), z.unknown()),
            issues: z.array(configIssueSchema),
          }),
          400: errorSchema,
          403: errorSchema,
          404: errorSchema,
          409: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const { hostId, vmid } = request.params;
      const allowedHosts = await hostRegistry.listHosts(request.user);
      if (!allowedHosts.some((host) => host.id === hostId)) {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: `Access denied to host '${hostId}'`,
        });
      }
      if (request.user?.role === 'viewer') {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Viewer role cannot edit configuration files',
        });
      }

      const index = await indexConfiguredGuests(hostRegistry.dataDir);
      const guest = getConfiguredGuestFromIndex(index, hostId, vmid);
      if (!guest) {
        return reply.code(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: `Configured guest '${hostId}/${vmid}' was not found`,
        });
      }

      const proposed = parseGuestConfigurationForEditor(request.body.rawYaml, {
        vmid,
        name: guest.name,
        relativePath: guest.relativePath,
      });
      const current = await readGuestConfiguration(
        hostRegistry.dataDir,
        hostId,
        vmid,
      );
      const currentAdminOnly =
        current.status === 'configured'
          ? parseGuestConfigurationForEditor(current.rawYaml, {
              vmid,
              name: guest.name,
              relativePath: guest.relativePath,
            }).adminOnly
          : [];
      const adminOnly = mergeAdminOnlySurfaces(
        proposed.adminOnly,
        currentAdminOnly,
      );

      if (request.user?.role !== 'admin' && adminOnly.length > 0) {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message:
            'This file contains execution surfaces that only an administrator may edit',
          adminOnly: [...adminOnly],
        });
      }
      if (!proposed.ok) {
        return reply.code(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Deployment YAML failed validation',
          issues: [...proposed.issues],
          adminOnly: [...proposed.adminOnly],
        });
      }

      try {
        if (request.body.dryRun) {
          await new WriteGuard().assertCanWrite(
            guest.deploymentFile,
            request.body.expectedHash,
          );
          return {
            success: true as const,
            dryRun: true,
            rawYaml: request.body.rawYaml,
            hash: request.body.expectedHash,
            config: proposed.config as Record<string, unknown>,
            issues: [],
          };
        }
        const saved = await saveGuestConfiguration(
          guest,
          proposed,
          request.body.expectedHash,
        );
        await repos.auditLogs.append({
          userId: request.user?.id,
          username: request.user?.username,
          hostId,
          vmid,
          action: 'config.guest.save',
          reason: 'manual',
          diff: {
            relativePath: guest.relativePath,
            beforeHash: request.body.expectedHash,
            afterHash: saved.hash,
          },
          metadata: { adminOnly },
        });
        return {
          success: true as const,
          dryRun: false,
          rawYaml: saved.rawYaml,
          hash: saved.hash,
          config: saved.config as Record<string, unknown>,
          issues: [],
        };
      } catch (error) {
        if (error instanceof WriteConflictError) {
          return reply.code(409).send({
            statusCode: 409,
            error: 'Conflict',
            message:
              'The YAML file changed outside this editor. Reload it before saving.',
          });
        }
        throw error;
      }
    },
  );
};

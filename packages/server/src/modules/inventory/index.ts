import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  planGuestImport,
  applyGuestImport,
  deploymentDefaultsFileSchema,
  loadYamlDocument,
} from '@hacm/core';
import type { LiveInventoryService } from '../../inventory/service.js';
import type { HostRegistry } from '../../hosts/registry.js';
import {
  getConfiguredGuestFromIndex,
  indexConfiguredGuests,
  readGuestConfiguration,
} from '../../inventory/configuration.js';

export interface InventoryModuleOptions {
  readonly inventoryService: LiveInventoryService;
  readonly hostRegistry: HostRegistry;
}

const channelHealthSchema = z.object({
  ok: z.boolean(),
  status: z.string(),
  error: z.string().optional(),
  lastCheckedAt: z.string().optional(),
});

const liveGuestSummarySchema = z.object({
  hostId: z.string(),
  vmid: z.number(),
  name: z.string(),
  type: z.enum(['lxc', 'vm']),
  status: z.string(),
  node: z.string(),
  cpu: z.number().optional(),
  maxcpu: z.number().optional(),
  mem: z.number().optional(),
  maxmem: z.number().optional(),
  uptime: z.number().optional(),
  lock: z.string().optional(),
  tags: z.array(z.string()).readonly().optional(),
});

const resourceGuestSummarySchema = liveGuestSummarySchema.extend({
  configuration: z.discriminatedUnion('status', [
    z.object({ status: z.literal('orphan') }),
    z.object({
      status: z.literal('configured'),
      relativePath: z.string(),
    }),
  ]),
});

const guestConfigurationDetailSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('orphan') }),
  z.object({
    status: z.literal('configured'),
    relativePath: z.string(),
    rawYaml: z.string(),
    hash: z.string(),
    config: z.record(z.string(), z.unknown()).optional(),
    issues: z.array(
      z.object({
        path: z.string(),
        message: z.string(),
        code: z.string(),
      }),
    ),
  }),
]);

const hostInventorySummarySchema = z.object({
  hostId: z.string(),
  name: z.string(),
  status: z.enum(['online', 'offline', 'degraded', 'error']),
  guestCount: z.number(),
  channels: z.object({
    ssh: channelHealthSchema,
    api: channelHealthSchema,
  }),
  lastRefreshedAt: z.string(),
  error: z.string().optional(),
});

export const inventoryModule: FastifyPluginAsyncZod<
  InventoryModuleOptions
> = async (app, options) => {
  const { inventoryService, hostRegistry } = options;

  app.get(
    '/api/inventory/hosts',
    {
      schema: {
        tags: ['Inventory'],
        summary: 'List live inventory status for all hosts',
        response: {
          200: z.object({
            hosts: z.array(hostInventorySummarySchema),
          }),
        },
      },
    },
    async (request) => {
      const allowedHosts = await hostRegistry.listHosts(request.user);
      const allowedIds = new Set(allowedHosts.map((h) => h.id));

      const allInventories = await inventoryService.getAllInventories();
      const hosts = allInventories
        .filter((inv) => allowedIds.has(inv.hostId))
        .map((inv) => ({
          hostId: inv.hostId,
          name: inv.name,
          status: inv.status,
          guestCount: inv.guests.length,
          channels: inv.channels,
          lastRefreshedAt: inv.lastRefreshedAt,
          ...(inv.error ? { error: inv.error } : {}),
        }));

      return { hosts };
    },
  );

  app.get(
    '/api/inventory/guests',
    {
      schema: {
        tags: ['Inventory'],
        summary: 'List live guests across hosts',
        querystring: z.object({
          hostId: z.string().optional(),
          type: z.enum(['lxc', 'vm']).optional(),
          status: z.string().optional(),
        }),
        response: {
          200: z.object({
            guests: z.array(resourceGuestSummarySchema),
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
      const { hostId, type, status } = request.query;
      const allowedHosts = await hostRegistry.listHosts(request.user);
      const allowedIds = new Set(allowedHosts.map((h) => h.id));

      if (hostId && !allowedIds.has(hostId)) {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: `Access denied to host '${hostId}'`,
        });
      }

      const guests = await inventoryService.listGuests({
        ...(hostId ? { hostId } : {}),
        ...(type ? { type } : {}),
        ...(status ? { status } : {}),
      });

      const configuredGuests = await indexConfiguredGuests(
        hostRegistry.dataDir,
      );
      const filteredGuests = guests
        .filter((g) => allowedIds.has(g.hostId))
        .map((guest) => {
          const configured = getConfiguredGuestFromIndex(
            configuredGuests,
            guest.hostId,
            guest.vmid,
          );
          return {
            ...guest,
            configuration: configured
              ? {
                  status: 'configured' as const,
                  relativePath: configured.relativePath,
                }
              : { status: 'orphan' as const },
          };
        });

      return { guests: filteredGuests };
    },
  );

  app.get(
    '/api/inventory/guests/:hostId/:vmid',
    {
      schema: {
        tags: ['Inventory'],
        summary: 'Get live config and canonical details for a guest',
        params: z.object({
          hostId: z.string(),
          vmid: z.coerce.number(),
        }),
        querystring: z.object({
          type: z.enum(['lxc', 'vm']).optional(),
        }),
        response: {
          200: z.object({
            summary: liveGuestSummarySchema,
            rawConfig: z.string(),
            canonicalConfig: z.record(z.string(), z.unknown()),
            source: z.enum(['api', 'ssh']),
            configuration: guestConfigurationDetailSchema,
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
      const { hostId, vmid } = request.params;
      const allowedHosts = await hostRegistry.listHosts(request.user);
      const isAllowed = allowedHosts.some((h) => h.id === hostId);

      if (!isAllowed) {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: `Access denied to host '${hostId}'`,
        });
      }

      try {
        const detail = await inventoryService.getGuestLiveConfig(
          hostId,
          vmid,
          request.query.type,
        );
        const configuration = await readGuestConfiguration(
          hostRegistry.dataDir,
          hostId,
          vmid,
        );
        return {
          summary: detail.summary,
          rawConfig: detail.rawConfig,
          canonicalConfig: detail.canonicalConfig as Record<string, unknown>,
          source: detail.source,
          configuration:
            configuration.status === 'configured'
              ? {
                  status: configuration.status,
                  relativePath: configuration.relativePath,
                  rawYaml: configuration.rawYaml,
                  hash: configuration.hash,
                  issues: [...configuration.issues],
                  ...(configuration.config
                    ? {
                        config: configuration.config as Record<string, unknown>,
                      }
                    : {}),
                }
              : configuration,
        };
      } catch (err) {
        return reply.code(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  app.post(
    '/api/inventory/refresh',
    {
      schema: {
        tags: ['Inventory'],
        summary: 'Manually trigger inventory refresh',
        body: z
          .object({
            hostId: z.string().optional(),
          })
          .optional(),
        response: {
          200: z.object({
            refreshed: z.boolean(),
            timestamp: z.string(),
          }),
        },
      },
    },
    async (request) => {
      const hostId = request.body?.hostId;
      if (hostId) {
        await inventoryService.getHostInventory(hostId, true);
      } else {
        await inventoryService.getAllInventories(true);
      }

      return {
        refreshed: true,
        timestamp: new Date().toISOString(),
      };
    },
  );

  app.post(
    '/api/inventory/hosts/:hostId/refresh',
    {
      schema: {
        tags: ['Inventory'],
        summary: 'Manually refresh inventory for a single host',
        params: z.object({
          hostId: z.string(),
        }),
        response: {
          200: z.object({
            host: hostInventorySummarySchema,
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
      const { hostId } = request.params;
      const allowedHosts = await hostRegistry.listHosts(request.user);
      const isAllowed = allowedHosts.some((h) => h.id === hostId);

      if (!isAllowed) {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: `Access denied to host '${hostId}'`,
        });
      }

      const inv = await inventoryService.getHostInventory(hostId, true);
      return {
        host: {
          hostId: inv.hostId,
          name: inv.name,
          status: inv.status,
          guestCount: inv.guests.length,
          channels: inv.channels,
          lastRefreshedAt: inv.lastRefreshedAt,
          ...(inv.error ? { error: inv.error } : {}),
        },
      };
    },
  );

  app.post(
    '/api/inventory/guests/:hostId/:vmid/import',
    {
      schema: {
        tags: ['Inventory'],
        summary: 'Import a live guest into YAML configuration',
        params: z.object({
          hostId: z.string(),
          vmid: z.coerce.number(),
        }),
        body: z
          .object({
            dryRun: z.boolean().optional(),
            overwrite: z.boolean().optional(),
          })
          .optional(),
        response: {
          200: z.object({
            success: z.boolean(),
            status: z.enum(['new', 'already_exists']),
            relativeFile: z.string(),
            fullPath: z.string(),
            yamlContent: z.string(),
            omittedDefaults: z.array(z.string()).readonly(),
            reason: z.string().optional(),
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
      const { hostId, vmid } = request.params;
      const { dryRun = false, overwrite = false } = request.body ?? {};

      // Viewer cannot mutate YAML files
      if (request.user?.role === 'viewer' && !dryRun) {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Viewer role cannot import guests without dryRun: true',
        });
      }

      const allowedHosts = await hostRegistry.listHosts(request.user);
      const isAllowed = allowedHosts.some((h) => h.id === hostId);

      if (!isAllowed) {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: `Access denied to host '${hostId}'`,
        });
      }

      try {
        const liveDetail = await inventoryService.getGuestLiveConfig(
          hostId,
          vmid,
        );

        // Try to load default-deployment.yaml for host if present
        let defaults:
          ReturnType<typeof deploymentDefaultsFileSchema.parse> | undefined =
          undefined;
        try {
          const defaultsPath = join(
            hostRegistry.dataDir,
            'hosts',
            hostId,
            'default-deployment.yaml',
          );
          const defaultsContent = await readFile(defaultsPath, 'utf8');
          const doc = loadYamlDocument(defaultsContent);
          defaults = deploymentDefaultsFileSchema.parse(doc.toJSON());
        } catch {
          // Defaults file is optional
        }

        const plan = await planGuestImport({
          dataDir: hostRegistry.dataDir,
          hostId,
          guest: liveDetail.canonicalConfig,
          defaults,
        });

        if (dryRun) {
          return {
            success: plan.status === 'new' || overwrite,
            status: plan.status,
            relativeFile: plan.relativeFile,
            fullPath: plan.fullPath,
            yamlContent: plan.yamlContent,
            omittedDefaults: plan.omittedDefaults,
            ...(plan.status === 'already_exists'
              ? { reason: 'already_exists' }
              : {}),
          };
        }

        const applyResult = await applyGuestImport({
          plan,
          overwrite,
        });

        return {
          success: applyResult.success,
          status: plan.status,
          relativeFile: applyResult.relativeFile,
          fullPath: applyResult.fullPath,
          yamlContent: plan.yamlContent,
          omittedDefaults: plan.omittedDefaults,
          ...(applyResult.reason ? { reason: applyResult.reason } : {}),
        };
      } catch (err) {
        return reply.code(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  app.post(
    '/api/inventory/import',
    {
      schema: {
        tags: ['Inventory'],
        summary: 'Bulk import live guests into YAML',
        body: z.object({
          hostId: z.string(),
          vmids: z.array(z.number()),
          dryRun: z.boolean().optional(),
          overwrite: z.boolean().optional(),
        }),
        response: {
          200: z.object({
            results: z.array(
              z.object({
                vmid: z.number(),
                success: z.boolean(),
                status: z.enum(['new', 'already_exists']),
                relativeFile: z.string(),
                omittedDefaults: z.array(z.string()).readonly(),
                reason: z.string().optional(),
              }),
            ),
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
      const { hostId, vmids, dryRun = false, overwrite = false } = request.body;

      if (request.user?.role === 'viewer' && !dryRun) {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Viewer role cannot import guests without dryRun: true',
        });
      }

      const allowedHosts = await hostRegistry.listHosts(request.user);
      const isAllowed = allowedHosts.some((h) => h.id === hostId);

      if (!isAllowed) {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: `Access denied to host '${hostId}'`,
        });
      }

      let defaults:
        ReturnType<typeof deploymentDefaultsFileSchema.parse> | undefined =
        undefined;
      try {
        const defaultsPath = join(
          hostRegistry.dataDir,
          'hosts',
          hostId,
          'default-deployment.yaml',
        );
        const defaultsContent = await readFile(defaultsPath, 'utf8');
        const doc = loadYamlDocument(defaultsContent);
        defaults = deploymentDefaultsFileSchema.parse(doc.toJSON());
      } catch {
        // Optional
      }

      const results = [];
      for (const vmid of vmids) {
        try {
          const liveDetail = await inventoryService.getGuestLiveConfig(
            hostId,
            vmid,
          );
          const plan = await planGuestImport({
            dataDir: hostRegistry.dataDir,
            hostId,
            guest: liveDetail.canonicalConfig,
            defaults,
          });

          if (dryRun) {
            results.push({
              vmid,
              success: plan.status === 'new' || overwrite,
              status: plan.status,
              relativeFile: plan.relativeFile,
              omittedDefaults: plan.omittedDefaults,
              ...(plan.status === 'already_exists'
                ? { reason: 'already_exists' }
                : {}),
            });
            continue;
          }

          const applyResult = await applyGuestImport({
            plan,
            overwrite,
          });

          results.push({
            vmid,
            success: applyResult.success,
            status: plan.status,
            relativeFile: applyResult.relativeFile,
            omittedDefaults: plan.omittedDefaults,
            ...(applyResult.reason ? { reason: applyResult.reason } : {}),
          });
        } catch (err) {
          results.push({
            vmid,
            success: false,
            status: 'already_exists' as const,
            relativeFile: '',
            omittedDefaults: [],
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return { results };
    },
  );
};

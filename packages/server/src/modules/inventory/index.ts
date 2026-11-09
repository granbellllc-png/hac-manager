import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  addIgnoredGuest,
  applyGuestImport,
  deploymentDefaultsFileSchema,
  ignoredGuestFingerprint,
  isIgnoredGuest,
  loadYamlDocument,
  planGuestImport,
  sanitizeAuditPayload,
} from '@hacm/core';
import type { DatabaseRepositories } from '../../db/repositories/types.js';
import type { LiveInventoryService } from '../../inventory/service.js';
import type { LiveGuestSummary } from '../../inventory/types.js';
import type { HostRegistry } from '../../hosts/registry.js';
import {
  classifyGuests,
  type GuestConfigurationClassification,
} from '../../inventory/classification.js';
import { readGuestConfiguration } from '../../inventory/configuration.js';
import type { GuestLifecycleService } from '../../guests/service.js';
import { GuestStateUnavailableError } from '../../guests/types.js';

export interface InventoryModuleOptions {
  readonly inventoryService: LiveInventoryService;
  readonly hostRegistry: HostRegistry;
  readonly repos: DatabaseRepositories;
  readonly guestLifecycleService?: GuestLifecycleService | undefined;
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

const ignoredGuestEntrySchema = z.object({
  vmid: z.number(),
  name: z.string(),
  fingerprint: z.string().optional(),
});

const resourceGuestSummarySchema = liveGuestSummarySchema.extend({
  configuration: z.discriminatedUnion('status', [
    z.object({ status: z.literal('orphan') }),
    z.object({
      status: z.literal('ignored'),
      entry: ignoredGuestEntrySchema,
    }),
    z.object({
      status: z.literal('configured'),
      relativePath: z.string(),
    }),
  ]),
});

const guestConfigurationDetailSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('orphan') }),
  z.object({ status: z.literal('ignored') }),
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
  orphanCount: z.number(),
  ignoredCount: z.number(),
  channels: z.object({
    ssh: channelHealthSchema,
    api: channelHealthSchema,
  }),
  lastRefreshedAt: z.string(),
  error: z.string().optional(),
});

function configurationPayload(configuration: GuestConfigurationClassification):
  | { status: 'configured'; relativePath: string }
  | { status: 'orphan' }
  | {
      status: 'ignored';
      entry: { vmid: number; name: string; fingerprint?: string };
    } {
  if (configuration.status === 'configured') {
    return {
      status: 'configured',
      relativePath: configuration.relativePath,
    };
  }
  if (configuration.status === 'ignored') {
    return {
      status: 'ignored',
      entry: {
        vmid: configuration.entry.vmid,
        name: configuration.entry.name,
        ...(configuration.entry.fingerprint
          ? { fingerprint: configuration.entry.fingerprint }
          : {}),
      },
    };
  }
  return { status: 'orphan' };
}

function identityFor(guest: LiveGuestSummary) {
  return {
    vmid: guest.vmid,
    name: guest.name,
    type: guest.type,
    node: guest.node,
  };
}

async function countsFor(
  dataDir: string,
  guests: readonly LiveGuestSummary[],
): Promise<{ orphanCount: number; ignoredCount: number }> {
  const classified = await classifyGuests(dataDir, guests);
  return {
    orphanCount: classified.filter(
      (entry) => entry.configuration.status === 'orphan',
    ).length,
    ignoredCount: classified.filter(
      (entry) => entry.configuration.status === 'ignored',
    ).length,
  };
}

export const inventoryModule: FastifyPluginAsyncZod<
  InventoryModuleOptions
> = async (app, options) => {
  const { inventoryService, hostRegistry, repos } = options;

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
      const visible = allInventories.filter((inv) =>
        allowedIds.has(inv.hostId),
      );
      const classified = await classifyGuests(
        hostRegistry.dataDir,
        visible.flatMap((inv) => inv.guests),
      );
      const hosts = visible.map((inv) => {
        const own = classified.filter(
          (entry) => entry.guest.hostId === inv.hostId,
        );
        return {
          hostId: inv.hostId,
          name: inv.name,
          status: inv.status,
          guestCount: inv.guests.length,
          orphanCount: own.filter(
            (entry) => entry.configuration.status === 'orphan',
          ).length,
          ignoredCount: own.filter(
            (entry) => entry.configuration.status === 'ignored',
          ).length,
          channels: inv.channels,
          lastRefreshedAt: inv.lastRefreshedAt,
          ...(inv.error ? { error: inv.error } : {}),
        };
      });

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

      const visible = guests.filter((guest) => allowedIds.has(guest.hostId));
      const classified = await classifyGuests(hostRegistry.dataDir, visible);
      const filteredGuests = classified.map(({ guest, configuration }) => ({
        ...guest,
        configuration: configurationPayload(configuration),
      }));

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
        const ignored =
          configuration.status === 'orphan' &&
          (await isIgnoredGuest(
            hostRegistry.dataDir,
            hostId,
            vmid,
            identityFor(detail.summary),
          ));
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
              : ignored
                ? { status: 'ignored' as const }
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

  app.get(
    '/api/inventory/guests/:hostId/:vmid/identity',
    {
      schema: {
        tags: ['Inventory'],
        summary: 'Inspect the anti-collision identity of a guest',
        params: z.object({
          hostId: z.string(),
          vmid: z.coerce.number(),
        }),
        querystring: z.object({
          runChecks: z.coerce.boolean().optional(),
        }),
        response: {
          200: z.object({
            hostId: z.string(),
            vmid: z.number(),
            name: z.string(),
            type: z.enum(['lxc', 'vm']),
            status: z.enum([
              'missing',
              'verified',
              'unmanaged',
              'name-mismatch',
              'type-mismatch',
              'stamp-mismatch',
            ]),
            managed: z.boolean(),
            expectedUuid: z.string(),
            actualUuid: z.string().optional(),
            messages: z.array(z.string()).readonly(),
            checks: z
              .array(
                z.object({
                  check: z.string(),
                  ok: z.boolean(),
                  exitCode: z.number(),
                  stderr: z.string(),
                }),
              )
              .readonly(),
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
          409: z.object({
            statusCode: z.number(),
            error: z.string(),
            message: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const lifecycle = options.guestLifecycleService;
      if (!lifecycle) {
        return reply.code(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: 'Guest lifecycle checks are not configured',
        });
      }
      const { hostId, vmid } = request.params;
      const allowedHosts = await hostRegistry.listHosts(request.user);
      if (!allowedHosts.some((host) => host.id === hostId)) {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: `Access denied to host '${hostId}'`,
        });
      }
      try {
        const report = await lifecycle.getIdentityReport(hostId, vmid, {
          runIdentityChecks: request.query.runChecks ?? false,
        });
        if (!report) {
          return reply.code(404).send({
            statusCode: 404,
            error: 'Not Found',
            message: `Guest ${vmid} has no deployment YAML on host '${hostId}'`,
          });
        }
        return report;
      } catch (error) {
        if (error instanceof GuestStateUnavailableError) {
          return reply.code(409).send({
            statusCode: 409,
            error: 'Conflict',
            message: error.message,
          });
        }
        throw error;
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
      const counts = await countsFor(hostRegistry.dataDir, inv.guests);
      return {
        host: {
          hostId: inv.hostId,
          name: inv.name,
          status: inv.status,
          guestCount: inv.guests.length,
          ...counts,
          channels: inv.channels,
          lastRefreshedAt: inv.lastRefreshedAt,
          ...(inv.error ? { error: inv.error } : {}),
        },
      };
    },
  );

  app.post(
    '/api/inventory/guests/:hostId/:vmid/ignore',
    {
      schema: {
        tags: ['Inventory'],
        summary:
          'Ignore an unmanaged guest by recording its identity in host.yaml',
        params: z.object({
          hostId: z.string(),
          vmid: z.coerce.number(),
        }),
        body: z
          .object({
            dryRun: z.boolean().optional(),
          })
          .optional(),
        response: {
          200: z.object({
            ignored: z.literal(true),
            status: z.literal('ignored'),
            dryRun: z.boolean(),
            changed: z.boolean(),
            replaced: z.boolean(),
            relativeFile: z.string(),
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
          409: z.object({
            statusCode: z.number(),
            error: z.string(),
            message: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { hostId, vmid } = request.params;
      const dryRun = request.body?.dryRun ?? false;
      if (request.user?.role === 'viewer' && !dryRun) {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Viewer role cannot ignore guests without dryRun: true',
        });
      }

      const allowedHosts = await hostRegistry.listHosts(request.user);
      if (!allowedHosts.some((host) => host.id === hostId)) {
        return reply.code(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: `Access denied to host '${hostId}'`,
        });
      }

      const relativeFile = `hosts/${hostId}/host.yaml`;
      try {
        const detail = await inventoryService.getGuestLiveConfig(hostId, vmid);
        const configuration = await readGuestConfiguration(
          hostRegistry.dataDir,
          hostId,
          vmid,
        );
        if (configuration.status === 'configured') {
          return reply.code(409).send({
            statusCode: 409,
            error: 'Conflict',
            message: `Guest ${vmid} already has deployment YAML`,
          });
        }

        const identity = identityFor(detail.summary);
        if (dryRun) {
          const already = await isIgnoredGuest(
            hostRegistry.dataDir,
            hostId,
            vmid,
            identity,
          );
          return {
            ignored: true as const,
            status: 'ignored' as const,
            dryRun: true,
            changed: !already,
            replaced: false,
            relativeFile,
          };
        }

        const result = await addIgnoredGuest(
          hostRegistry.dataDir,
          hostId,
          identity,
        );
        if (!result.ignored) {
          if (result.reason === 'host_file_missing') {
            return reply.code(404).send({
              statusCode: 404,
              error: 'Not Found',
              message: `Host '${hostId}' has no host.yaml`,
            });
          }
          return reply.code(409).send({
            statusCode: 409,
            error: 'Conflict',
            message:
              'The ignored_guests list is provided by !include; edit the included file instead',
          });
        }

        if (result.changed) {
          await repos.auditLogs.append({
            userId: request.user?.id,
            username: request.user?.username,
            hostId,
            vmid,
            action: 'orphan.ignore',
            reason: 'orphan_action',
            diff: sanitizeAuditPayload({
              identity,
              fingerprint: ignoredGuestFingerprint(identity),
              replaced: result.replaced,
            }),
            metadata: { relativeFile },
          });
        }

        return {
          ignored: true as const,
          status: 'ignored' as const,
          dryRun: false,
          changed: result.changed,
          replaced: result.replaced,
          relativeFile,
        };
      } catch (error) {
        if (error instanceof GuestStateUnavailableError) {
          return reply.code(409).send({
            statusCode: 409,
            error: 'Conflict',
            message: error.message,
          });
        }
        return reply.code(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: error instanceof Error ? error.message : String(error),
        });
      }
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

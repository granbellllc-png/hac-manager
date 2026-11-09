import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { LiveInventoryService } from '../../inventory/service.js';
import type { HostRegistry } from '../../hosts/registry.js';

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
            guests: z.array(liveGuestSummarySchema),
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

      const filteredGuests = guests.filter((g) => allowedIds.has(g.hostId));

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
        return {
          summary: detail.summary,
          rawConfig: detail.rawConfig,
          canonicalConfig: detail.canonicalConfig as Record<string, unknown>,
          source: detail.source,
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
};

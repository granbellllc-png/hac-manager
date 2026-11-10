import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { HostRegistry } from '../../hosts/registry.js';
import type { ConsoleService } from '../../console/service.js';
import type { ConsoleSocket } from '../../console/types.js';

export interface ConsoleModuleOptions {
  readonly hostRegistry: HostRegistry;
  readonly consoleService: ConsoleService;
}

interface ConsoleWireSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: unknown) => void): void;
  on(event: 'close', listener: () => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
}

const querySchema = z
  .object({
    hostId: z.string().min(1),
    target: z.enum(['host', 'lxc']),
    vmid: z.coerce.number().int().min(100).optional(),
    cols: z.coerce.number().int().min(20).max(500).default(80),
    rows: z.coerce.number().int().min(5).max(200).default(24),
    recording: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
  })
  .superRefine((value, context) => {
    if (value.target === 'lxc' && value.vmid === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['vmid'],
        message: 'An LXC console requires a VMID',
      });
    }
  });

function hasSameOrigin(headers: Record<string, unknown>): boolean {
  const origin = headers['origin'];
  const host = headers['host'];
  if (typeof origin !== 'string' || typeof host !== 'string') return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function adaptConsoleSocket(socket: ConsoleWireSocket): ConsoleSocket {
  return {
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    onMessage: (listener) => {
      socket.on('message', (data) => listener(String(data)));
    },
    onClose: (listener) => {
      socket.on('close', listener);
    },
    onError: (listener) => {
      socket.on('error', listener);
    },
  };
}

export const consoleModule: FastifyPluginAsyncZod<
  ConsoleModuleOptions
> = async (app, options) => {
  app.get(
    '/api/console',
    {
      websocket: true,
      schema: {
        hide: true,
        querystring: querySchema,
      },
      preValidation: async (request, reply) => {
        if (!hasSameOrigin(request.headers)) {
          return reply.code(403).send({
            statusCode: 403,
            error: 'Forbidden',
            message: 'WebSocket origin is not allowed',
          });
        }
        if (request.user?.role === 'viewer') {
          return reply.code(403).send({
            statusCode: 403,
            error: 'Forbidden',
            message: 'Viewer role cannot open interactive consoles',
          });
        }
        const host = await options.hostRegistry.getHost(
          request.query.hostId,
          request.user,
        );
        if (!host) {
          const exists = options.hostRegistry.getRawHost(request.query.hostId);
          return reply.code(exists ? 403 : 404).send({
            statusCode: exists ? 403 : 404,
            error: exists ? 'Forbidden' : 'Not Found',
            message: exists
              ? `Access denied to host '${request.query.hostId}'`
              : `Host '${request.query.hostId}' not found`,
          });
        }
      },
    },
    async (socket, request) => {
      const adapter = adaptConsoleSocket(
        socket as unknown as ConsoleWireSocket,
      );
      await options.consoleService.open(adapter, {
        user: request.user!,
        request: {
          hostId: request.query.hostId,
          target: request.query.target,
          ...(request.query.vmid !== undefined
            ? { vmid: request.query.vmid }
            : {}),
          cols: request.query.cols,
          rows: request.query.rows,
          recording: request.query.recording,
        },
      });
    },
  );
};

export const consoleModuleInternals = {
  hasSameOrigin,
  querySchema,
  adaptConsoleSocket,
};

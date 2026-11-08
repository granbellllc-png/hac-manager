import { globalSecretRedactor } from '@hacm/core';
import pino, { type DestinationStream, type Logger } from 'pino';
import type { ServerConfig } from './config.js';

export function createLogger(
  config: ServerConfig,
  destination?: DestinationStream,
): Logger {
  return pino(
    {
      level: config.HACM_LOG_LEVEL,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
          'password',
          'token',
          'secret',
          'private_key',
          'token_secret',
          'api_key',
          'credential',
          '*.password',
          '*.token',
          '*.secret',
          '*.private_key',
          '*.token_secret',
          '*.api_key',
          '*.credential',
          '*.*.password',
          '*.*.token',
          '*.*.secret',
          '*.*.private_key',
          '*.*.token_secret',
        ],
        censor: '***',
      },
      serializers: {
        req(request: { method: string; url: string }) {
          return { method: request.method, url: request.url.split('?')[0] };
        },
      },
      hooks: {
        logMethod(args, method) {
          for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            if (typeof arg === 'string') {
              args[i] = globalSecretRedactor.redact(arg);
            }
          }
          method.apply(this, args);
        },
      },
    },
    destination,
  );
}

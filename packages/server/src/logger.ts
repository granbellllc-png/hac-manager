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
          '*.password',
          '*.token',
          '*.secret',
        ],
        censor: '***',
      },
      serializers: {
        req(request: { method: string; url: string }) {
          return { method: request.method, url: request.url.split('?')[0] };
        },
      },
      // Extension point for value-based redaction when secret providers are added.
      hooks: {
        logMethod(args, method) {
          method.apply(this, args);
        },
      },
    },
    destination,
  );
}

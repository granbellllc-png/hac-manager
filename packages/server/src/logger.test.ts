import { globalSecretRedactor } from '@hacm/core';
import type { DestinationStream } from 'pino';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';

describe('Server Logger Redaction', () => {
  const config = loadConfig({
    HACM_DATA_DIR: 'data',
    HACM_STATE_DIR: 'state',
    HACM_LOG_LEVEL: 'info',
  });

  it('redacts sensitive fields configured in paths', () => {
    let output = '';
    const destination: DestinationStream = {
      write(chunk: string) {
        output += chunk;
        return true;
      },
    };

    const logger = createLogger(config, destination);

    logger.info(
      {
        password: 'my-super-secret-password',
        token: 'my-bearer-token',
        private_key: 'PRIVATE-KEY-CONTENT',
        user: 'alice',
      },
      'User operation performed',
    );

    expect(output).not.toContain('my-super-secret-password');
    expect(output).not.toContain('my-bearer-token');
    expect(output).not.toContain('PRIVATE-KEY-CONTENT');
    expect(output).toContain('"password":"***"');
    expect(output).toContain('"token":"***"');
    expect(output).toContain('"private_key":"***"');
    expect(output).toContain('"user":"alice"');
  });

  it('scrubs registered secrets from log messages via globalSecretRedactor hook', () => {
    let output = '';
    const destination: DestinationStream = {
      write(chunk: string) {
        output += chunk;
        return true;
      },
    };

    const logger = createLogger(config, destination);

    const secretValue = 'custom-dynamic-secret-val-999';
    globalSecretRedactor.register(secretValue);

    logger.info(
      `Connecting to database with credentials ${secretValue} at host`,
    );

    expect(output).not.toContain(secretValue);
    expect(output).toContain(
      'Connecting to database with credentials *** at host',
    );
  });
});

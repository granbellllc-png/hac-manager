import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, loadConfig } from './index.js';
import { createLogger } from './logger.js';

const testDir = mkdtempSync(join(tmpdir(), 'hacm-app-test-'));
const dataDir = join(testDir, 'data');
const stateDir = join(testDir, 'state');

const config = loadConfig({
  HACM_DATA_DIR: dataDir,
  HACM_STATE_DIR: stateDir,
  HACM_LOG_LEVEL: 'silent',
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('Fastify API', () => {
  it('serves health and generates request ids without trusting the caller', async () => {
    const app = await buildApp(config);
    apps.push(app);
    const response = await app.inject({
      url: '/api/health',
      headers: { 'x-request-id': 'untrusted-caller' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', service: 'HAC Manager' });
    expect(response.headers['x-request-id']).toMatch(/^[a-f0-9-]{36}$/);
    expect(response.headers['x-request-id']).not.toBe('untrusted-caller');
    const res = await app.inject('/api/missing');
    expect(res.statusCode === 404 || res.statusCode === 401).toBe(true);
  });
  it('exports an OpenAPI schema derived from the health boundary', async () => {
    const app = await buildApp(config);
    apps.push(app);
    const response = await app.inject('/api/openapi.json');
    const document = response.json<{
      openapi: string;
      paths: Record<string, unknown>;
    }>();
    expect(response.statusCode).toBe(200);
    expect(document.openapi).toBe('3.1.0');
    expect(document.paths['/api/health']).toBeDefined();
    expect(document.paths['/api/openapi.json']).toBeUndefined();
  });
  it('redacts auth headers, nested credentials and query strings in structured logs', async () => {
    const lines: string[] = [];
    const logger = createLogger(
      { ...config, HACM_LOG_LEVEL: 'info' },
      {
        write: (line) => {
          lines.push(line);
        },
      },
    );
    const app = await buildApp(config, logger);
    apps.push(app);
    logger.info(
      {
        req: {
          method: 'GET',
          url: '/api/health?token=fake-query-secret',
          headers: {
            authorization: 'fake-auth-secret',
            cookie: 'fake-cookie-secret',
          },
        },
        secret: 'fake-root-secret',
        provider: { password: 'fake-password-secret' },
        res: { headers: { 'set-cookie': 'fake-response-secret' } },
      },
      'Safe metadata',
    );
    await app.inject({
      url: '/api/health?token=fake-query-secret',
      headers: { authorization: 'fake-auth-secret' },
    });
    const output = lines.join('');
    expect(output).toContain('***');
    for (const secret of [
      'fake-query-secret',
      'fake-auth-secret',
      'fake-cookie-secret',
      'fake-root-secret',
      'fake-password-secret',
      'fake-response-secret',
    ]) {
      expect(output).not.toContain(secret);
    }
  });
  it('serves an optional SPA without masking API errors or missing assets', async () => {
    const web = await mkdtemp(join(tmpdir(), 'hacm-web-'));
    try {
      await writeFile(join(web, 'index.html'), '<h1>Fake SPA</h1>');
      await writeFile(join(web, 'asset.js'), 'export const fake = true;');
      await writeFile(join(web, '.private'), 'fake-hidden-value');
      const app = await buildApp({ ...config, HACM_WEB_DIR: web });
      apps.push(app);
      expect((await app.inject('/')).body).toContain('Fake SPA');
      expect(
        (
          await app.inject({
            url: '/hosts/example',
            headers: { accept: 'text/html' },
          })
        ).body,
      ).toContain('Fake SPA');
      expect((await app.inject('/asset.js')).statusCode).toBe(200);
      expect((await app.inject('/.private')).statusCode).toBe(404);
      const apiMissingRes = await app.inject({
        url: '/api/missing',
        headers: { accept: 'text/html' },
      });
      expect(
        apiMissingRes.statusCode === 404 || apiMissingRes.statusCode === 401,
      ).toBe(true);
      expect(
        (
          await app.inject({
            url: '/missing.js',
            headers: { accept: 'text/html' },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            url: '/hosts/example',
            method: 'POST',
            headers: { accept: 'text/html' },
          })
        ).statusCode,
      ).toBe(404);
      expect((await app.inject('/hosts/example')).statusCode).toBe(404);
      await app.close();
    } finally {
      await rm(web, { recursive: true, force: true });
    }
  });
});

import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import { startServer } from './start.js';

const testDir = mkdtempSync(join(tmpdir(), 'hacm-start-test-'));
const dataDir = join(testDir, 'data');
const stateDir = join(testDir, 'state');

const config = {
  ...loadConfig({
    HACM_DATA_DIR: dataDir,
    HACM_STATE_DIR: stateDir,
    HACM_LOG_LEVEL: 'silent',
  }),
  HACM_PORT: 0,
};

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

it('logs shutdown errors so cancellation failures remain observable', async () => {
  const shutdown = new AbortController();
  const app = await startServer(config, shutdown.signal);
  const log = vi.spyOn(app.log, 'error');
  const error = new Error('Fake close failure');
  const close = vi.spyOn(app, 'close').mockRejectedValueOnce(error);
  try {
    shutdown.abort();
    await expect.poll(() => log.mock.calls.length).toBe(1);
    expect(log).toHaveBeenCalledWith({ err: error }, 'Shutdown failed');
  } finally {
    close.mockRestore();
    await app.close();
  }
});

it('serves on loopback and closes gracefully on cancellation', async () => {
  const shutdown = new AbortController();
  const app = await startServer(config, shutdown.signal);
  const address = app.server.address();
  expect(address).not.toBeNull();
  if (typeof address !== 'object' || !address) {
    throw new Error('Expected TCP listener');
  }
  expect(
    (await fetch(`http://127.0.0.1:${address.port}/api/health`)).status,
  ).toBe(200);
  const closed = once(app.server, 'close');
  shutdown.abort();
  await closed;
  expect(app.server.listening).toBe(false);
});
it('cleans up a listener even when shutdown was already requested', async () => {
  const app = await startServer(config, AbortSignal.abort());
  expect(app.server.listening).toBe(false);
});
it('starts without a signal and supports explicit close', async () => {
  const app = await startServer(config);
  await app.close();
  expect(app.server.listening).toBe(false);
});
it('reports bind failures instead of leaving the app running', async () => {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  if (typeof address !== 'object' || !address) {
    throw new Error('Expected TCP listener');
  }
  try {
    await expect(
      startServer({ ...config, HACM_PORT: address.port }),
    ).rejects.toThrow('EADDRINUSE');
  } finally {
    listener.close();
    await once(listener, 'close');
  }
});

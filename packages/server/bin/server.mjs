import { loadConfig, startServer } from '../dist/index.js';
import process from 'node:process';

const shutdown = new globalThis.AbortController();
process.once('SIGTERM', () => shutdown.abort());
process.once('SIGINT', () => shutdown.abort());
try {
  await startServer(loadConfig(), shutdown.signal);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Server startup failed'}\n`,
  );
  process.exitCode = 1;
}

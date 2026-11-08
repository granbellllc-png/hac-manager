import { loadConfig, startServer } from '../src/index.js';

const shutdown = new AbortController();
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

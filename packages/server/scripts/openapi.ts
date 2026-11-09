import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp, loadConfig } from '../src/index.js';

const tempDir = await mkdtemp(join(tmpdir(), 'hacm-openapi-'));
const app = await buildApp(
  loadConfig({
    HACM_DATA_DIR: join(tempDir, 'data'),
    HACM_STATE_DIR: join(tempDir, 'state'),
    HACM_LOG_LEVEL: 'silent',
  }),
);
try {
  await app.ready();
  await writeFile(
    resolve(import.meta.dirname, '../openapi.json'),
    `${JSON.stringify(app.swagger(), null, 2)}\n`,
  );
} finally {
  await app.close();
  await rm(tempDir, { recursive: true, force: true });
}

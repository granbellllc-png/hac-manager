import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildApp, loadConfig } from '../src/index.js';

const app = await buildApp(
  loadConfig({
    HACM_DATA_DIR: '/example-data',
    HACM_STATE_DIR: '/example-state',
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
}

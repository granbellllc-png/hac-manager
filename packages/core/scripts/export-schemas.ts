import { resolve } from 'node:path';
import { exportSchemas } from '../src/index.js';

const outDir = resolve(import.meta.dirname, '../dist/schemas');
exportSchemas({
  outDir,
  docs: process.argv.includes('--docs'),
});

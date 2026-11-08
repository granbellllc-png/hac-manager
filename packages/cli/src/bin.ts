#!/usr/bin/env node
import { runCli } from './cli.js';

runCli(process.argv.slice(2))
  .then((code) => {
    if (code !== 0) {
      process.exit(code);
    }
  })
  .catch((err) => {
    process.stderr.write(`${(err as Error).stack ?? err}\n`);
    process.exit(1);
  });

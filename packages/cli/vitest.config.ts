import { defineConfig, mergeConfig } from 'vitest/config';
import { sharedTestConfig } from '../../vitest.shared.js';
export default mergeConfig(
  sharedTestConfig,
  defineConfig({ test: { name: 'cli', root: import.meta.dirname } }),
);

import { defineConfig } from 'vitest/config';

export const sharedTestConfig = defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    clearMocks: true,
    restoreMocks: true,
  },
});

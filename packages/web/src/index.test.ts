import { expect, it } from 'vitest';
import { projectName } from './index.js';
it('resolves the shared core package through the web workspace', () => {
  expect(projectName).toBe('HAC Manager');
});

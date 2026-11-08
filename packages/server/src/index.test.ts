import { expect, it } from 'vitest';
import { projectName } from './index.js';
it('resolves the shared core package through the server workspace', () => {
  expect(projectName).toBe('HAC Manager');
});

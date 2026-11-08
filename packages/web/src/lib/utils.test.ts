import { describe, expect, it } from 'vitest';
import { cn } from './utils';

describe('cn', () => {
  it('merges conflicting tailwind classes', () => {
    expect(cn('p-2', false, 'p-4')).toBe('p-4');
  });
});

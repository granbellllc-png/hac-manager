import { describe, expect, it } from 'vitest';
import { toErrorMessage } from './errors.js';

describe('toErrorMessage', () => {
  it('returns the message of an Error', () => {
    expect(toErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('stringifies non-Error throwables', () => {
    expect(toErrorMessage('plain text')).toBe('plain text');
    expect(toErrorMessage(42)).toBe('42');
  });
});

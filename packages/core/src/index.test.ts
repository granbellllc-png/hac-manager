import { describe, expect, it } from 'vitest';
import { isGuestType } from './index.js';

describe('guest terminology', () => {
  it.each(['lxc', 'vm'])('recognises the supported guest type %s', (type) => {
    expect(isGuestType(type)).toBe(true);
  });
  it.each(['host', 'node', 'docker', '', null, undefined, 112, {}])(
    'rejects unsupported guest types (%s)',
    (type) => {
      expect(isGuestType(type)).toBe(false);
    },
  );
});

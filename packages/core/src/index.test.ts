import { describe, expect, it } from 'vitest';
import {
  isGuestType,
  parseProxmoxConfig,
  serialiseProxmoxConfig,
} from './index.js';

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
  it('exports codec helpers', () => {
    expect(typeof parseProxmoxConfig).toBe('function');
    expect(typeof serialiseProxmoxConfig).toBe('function');
  });
});

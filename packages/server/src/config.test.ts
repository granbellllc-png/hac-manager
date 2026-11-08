import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';

const env = {
  HACM_DATA_DIR: '/example-data',
  HACM_STATE_DIR: '/example-state',
};

describe('server configuration', () => {
  it('defaults to loopback and resolves separate runtime paths', () => {
    const config = loadConfig(env);
    expect(config.HACM_HOST).toBe('127.0.0.1');
    expect(config.HACM_PORT).toBe(3000);
    expect(config.HACM_DATA_DIR).toBe(resolve('/example-data'));
    expect(config.HACM_COOKIE_SECURE).toBe(true);
    expect(config.HACM_WEB_DIR).toBeUndefined();
  });
  it('parses configured optional values', () => {
    const config = loadConfig({
      ...env,
      HACM_PORT: '3456',
      HACM_WEB_DIR: '/example-web',
      HACM_COOKIE_SECURE: 'false',
      HACM_PROTECTED_GUEST_ID: '112',
      HACM_PROTECTED_HOST_ID: 'example-host',
    });
    expect(config.HACM_PORT).toBe(3456);
    expect(config.HACM_WEB_DIR).toBe(resolve('/example-web'));
    expect(config.HACM_COOKIE_SECURE).toBe(false);
    expect(config.HACM_PROTECTED_GUEST_ID).toBe(112);
  });
  it('accepts empty optional dotenv values', () => {
    expect(
      loadConfig({ ...env, HACM_WEB_DIR: '', HACM_PROTECTED_GUEST_ID: '' })
        .HACM_PROTECTED_GUEST_ID,
    ).toBeUndefined();
  });
  it.each(['0', '65536', 'oops', '1.5'])(
    'rejects invalid ports %s',
    (value) => {
      expect(() => loadConfig({ ...env, HACM_PORT: value })).toThrow(
        'HACM_PORT',
      );
    },
  );
  it('requires the data and state paths', () => {
    expect(() => loadConfig({})).toThrow('HACM_DATA_DIR');
  });
  it.each(['/example-data', '/example-data/state'])(
    'keeps runtime state out of the data dir (%s)',
    (state) => {
      expect(() => loadConfig({ ...env, HACM_STATE_DIR: state })).toThrow(
        'State dir must be outside',
      );
    },
  );
  it('does not echo invalid environment secret values', () => {
    expect(() =>
      loadConfig({ ...env, HACM_SESSION_SECRET: 'fake-sensitive-value' }),
    ).toThrow('HACM_SESSION_SECRET');
    try {
      loadConfig({ ...env, HACM_SESSION_SECRET: 'fake-sensitive-value' });
    } catch (error) {
      expect(String(error)).not.toContain('fake-sensitive-value');
    }
  });
});

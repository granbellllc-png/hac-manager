import { describe, expect, it } from 'vitest';
import { Secret } from '../tags/secret.js';
import { SecretRedactor } from './redactor.js';
import { sanitizeAuditPayload, sanitizeDiff } from './sanitize.js';

describe('redaction lifecycle', () => {
  it('tracks registered secrets, handles overlaps, and removes cleared registrations', () => {
    const redactor = new SecretRedactor({
      minSecretLength: 4,
      mask: '[hidden]',
    });
    const wrapped = new Secret('fixture-long-secret');
    redactor.registerAll([
      null,
      undefined,
      '',
      'x',
      wrapped,
      'fixture',
      'fixture',
    ]);
    expect(redactor.size).toBe(2);
    expect(redactor.redactLine('fixture-long-secret and fixture')).toBe(
      '[hidden] and [hidden]',
    );
    expect(redactor.redact('unrelated')).toBe('unrelated');
    redactor.unregister(wrapped);
    redactor.unregister('absent');
    expect(redactor.size).toBe(1);
    redactor.unregister('fixture');
    expect(redactor.redact('fixture')).toBe('fixture');
    redactor.register('again');
    redactor.clear();
    expect(redactor.size).toBe(0);
    expect(redactor.redact('again')).toBe('again');
  });

  it('sanitizes nested output while preserving null, undefined, numbers, and booleans', () => {
    const payload = {
      missing: undefined,
      empty: null,
      count: 3,
      enabled: false,
      rows: [null, true, { password: 'fake-password' }],
    };
    expect(sanitizeDiff(payload)).toEqual({
      ...payload,
      rows: [null, true, { password: '***' }],
    });
    expect(sanitizeAuditPayload(payload)).toEqual(sanitizeDiff(payload));
  });
});

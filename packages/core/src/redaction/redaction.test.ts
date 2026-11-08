import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { compareSecretValues, Secret } from '../tags/secret.js';
import { SecretRedactor } from './redactor.js';
import {
  isSensitiveKey,
  sanitizeAuditPayload,
  sanitizeDiff,
} from './sanitize.js';

describe('Secret Redaction & Leak Tests', () => {
  const superSecret = 'super-secret-password-xyz123';

  describe('Secret class security invariants', () => {
    it('serializes to *** in JSON.stringify', () => {
      const secret = new Secret(superSecret);
      const payload = {
        name: 'test',
        password: secret,
        nested: { token: secret },
      };

      const json = JSON.stringify(payload);
      expect(json).not.toContain(superSecret);
      expect(JSON.parse(json)).toEqual({
        name: 'test',
        password: '***',
        nested: { token: '***' },
      });
    });

    it('masks in toString and util.inspect', () => {
      const secret = new Secret(superSecret);
      expect(secret.toString()).toBe('***');
      expect(`${secret}`).toBe('***');
      expect(inspect(secret)).toBe('[Secret: ***]');
    });

    it('compares secrets by hash without exposing plaintext', () => {
      const secretA = new Secret('mypassword');
      const secretB = new Secret('mypassword');
      const secretC = new Secret('otherpassword');

      expect(secretA.equals(secretB)).toBe(true);
      expect(secretA.equals(secretC)).toBe(false);

      expect(compareSecretValues(secretA, secretB)).toBe(true);
      expect(compareSecretValues(secretA, 'mypassword')).toBe(true);
      expect(compareSecretValues('mypassword', secretB)).toBe(true);
      expect(compareSecretValues(secretA, secretC)).toBe(false);
    });
  });

  describe('SecretRedactor', () => {
    it('scrubs registered secret strings from log lines and command echoes', () => {
      const redactor = new SecretRedactor();
      redactor.register(superSecret);
      redactor.register('another-secret-token-789');

      const commandEcho = `ssh -p 22 root@host --password="${superSecret}" --token another-secret-token-789`;
      const scrubbed = redactor.redactLine(commandEcho);

      expect(scrubbed).not.toContain(superSecret);
      expect(scrubbed).not.toContain('another-secret-token-789');
      expect(scrubbed).toBe('ssh -p 22 root@host --password="***" --token ***');
    });

    it('redacts longer secrets first to avoid partial leaks', () => {
      const redactor = new SecretRedactor();
      redactor.register('secret');
      redactor.register('secret-extended-token');

      const log = 'Executing with secret-extended-token now';
      const scrubbed = redactor.redact(log);
      expect(scrubbed).toBe('Executing with *** now');
    });

    it('ignores empty, short or noise strings below minSecretLength', () => {
      const redactor = new SecretRedactor({ minSecretLength: 4 });
      redactor.register('ab'); // too short
      expect(redactor.size).toBe(0);
      expect(redactor.redact('ab cd')).toBe('ab cd');
    });
  });

  describe('Audit and Diff Sanitizer Leak Tests', () => {
    it('proves sensitive keys are masked in audit payloads', () => {
      const redactor = new SecretRedactor();
      redactor.register(superSecret);

      const auditEvent = {
        action: 'user.login',
        user: 'admin',
        password: 'rawPasswordInPayload',
        token: 'rawBearerToken',
        details: {
          private_key: 'BEGIN RSA PRIVATE KEY',
          token_secret: 'secret-xyz',
          normalMessage: `Attempted authentication using ${superSecret}`,
        },
      };

      const sanitized = sanitizeAuditPayload(auditEvent, redactor);
      const json = JSON.stringify(sanitized);

      expect(json).not.toContain('rawPasswordInPayload');
      expect(json).not.toContain('rawBearerToken');
      expect(json).not.toContain('BEGIN RSA PRIVATE KEY');
      expect(json).not.toContain(superSecret);

      expect(sanitized.password).toBe('***');
      expect(sanitized.token).toBe('***');
      expect(sanitized.details.private_key).toBe('***');
      expect(sanitized.details.token_secret).toBe('***');
      expect(sanitized.details.normalMessage).toBe(
        'Attempted authentication using ***',
      );
    });

    it('proves secrets never leak in diff JSON', () => {
      const redactor = new SecretRedactor();
      redactor.register(superSecret);

      const diff = {
        guest: '112-test',
        changes: [
          {
            path: 'ssh.password',
            before: new Secret('old-secret-password'),
            after: new Secret(superSecret),
          },
          {
            path: 'extra.command',
            before: 'echo starting',
            after: `echo connecting with ${superSecret}`,
          },
        ],
      };

      const sanitizedDiff = sanitizeDiff(diff, redactor);
      const json = JSON.stringify(sanitizedDiff);

      expect(json).not.toContain('old-secret-password');
      expect(json).not.toContain(superSecret);
      expect(sanitizedDiff.changes[0]?.before).toBe('***');
      expect(sanitizedDiff.changes[0]?.after).toBe('***');
      expect(sanitizedDiff.changes[1]?.after).toBe('echo connecting with ***');
    });

    it('proves Error messages with secrets get scrubbed', () => {
      const redactor = new SecretRedactor();
      redactor.register(superSecret);

      const err = new Error(
        `Failed to connect with credentials: ${superSecret} at host`,
      );
      const scrubbed = redactor.redact(err.message);

      expect(scrubbed).not.toContain(superSecret);
      expect(scrubbed).toBe('Failed to connect with credentials: *** at host');
    });

    it('matches sensitive keys accurately', () => {
      expect(isSensitiveKey('password')).toBe(true);
      expect(isSensitiveKey('user_password')).toBe(true);
      expect(isSensitiveKey('api_key')).toBe(true);
      expect(isSensitiveKey('token_secret')).toBe(true);
      expect(isSensitiveKey('session_id')).toBe(true);
      expect(isSensitiveKey('username')).toBe(false);
      expect(isSensitiveKey('host')).toBe(false);
    });
  });
});

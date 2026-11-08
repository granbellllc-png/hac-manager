import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveAppKey, encryptSecret, decryptSecret } from './encryption.js';

describe('Encryption at rest', () => {
  it('derives key from configured HACM_SECRET_KEY', () => {
    const config = {
      HACM_SECRET_KEY: 'this-is-a-very-long-secret-key-32-chars-at-least!',
      HACM_STATE_DIR: path.join(os.tmpdir(), 'hacm-test-enc-1'),
    };
    const key1 = resolveAppKey(config);
    const key2 = resolveAppKey(config);

    expect(key1).toHaveLength(32);
    expect(key1).toEqual(key2);
  });

  it('generates and persists app.key file in state dir when secret key is not provided', () => {
    const stateDir = path.join(os.tmpdir(), `hacm-test-enc-${Date.now()}`);
    const keyPath = path.join(stateDir, 'app.key');

    try {
      const key1 = resolveAppKey({ HACM_STATE_DIR: stateDir });
      expect(key1).toHaveLength(32);
      expect(fs.existsSync(keyPath)).toBe(true);

      // Subsequent call should read the existing key file
      const key2 = resolveAppKey({ HACM_STATE_DIR: stateDir });
      expect(key2).toEqual(key1);
    } finally {
      if (fs.existsSync(stateDir)) {
        fs.rmSync(stateDir, { recursive: true, force: true });
      }
    }
  });

  it('reads raw 32-byte binary key from app.key if present', () => {
    const stateDir = path.join(os.tmpdir(), `hacm-test-raw-${Date.now()}`);
    const keyPath = path.join(stateDir, 'app.key');
    fs.mkdirSync(stateDir, { recursive: true });
    const raw32 = Buffer.alloc(32, 42);
    fs.writeFileSync(keyPath, raw32);

    try {
      const key = resolveAppKey({ HACM_STATE_DIR: stateDir });
      expect(key).toEqual(raw32);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('encrypts and decrypts secrets with AES-256-GCM', () => {
    const key = Buffer.alloc(32, 7);
    const plaintext = 'JBSWY3DPEHPK3PXP'; // Base32 test secret

    const encrypted = encryptSecret(plaintext, key);
    expect(encrypted.startsWith('v1:')).toBe(true);
    expect(encrypted).not.toContain(plaintext);

    const decrypted = decryptSecret(encrypted, key);
    expect(decrypted).toBe(plaintext);
  });

  it('rejects tampered or malformed ciphertexts', () => {
    const key = Buffer.alloc(32, 9);
    const plaintext = 'top-secret';
    const encrypted = encryptSecret(plaintext, key);

    // Corrupted tag
    const parts = encrypted.split(':');
    const badTag = parts.slice();
    badTag[2] = (badTag[2] ?? '').split('').reverse().join('');
    expect(() => decryptSecret(badTag.join(':'), key)).toThrow();

    // Unsupported version
    expect(() =>
      decryptSecret(`v2:${parts[1]}:${parts[2]}:${parts[3]}`, key),
    ).toThrow('Unsupported or malformed');

    // Malformed string
    expect(() => decryptSecret('invalid', key)).toThrow(
      'Unsupported or malformed',
    );
    expect(() => decryptSecret('v1::tag:data', key)).toThrow(
      'missing required fields',
    );
  });
});

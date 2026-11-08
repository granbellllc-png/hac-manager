import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ServerConfig } from '../config.js';

export interface AppKeyConfig {
  readonly HACM_SECRET_KEY?: string;
  readonly HACM_STATE_DIR: string;
}

/**
 * Resolves or generates the 32-byte encryption key used for secrets at rest.
 * If HACM_SECRET_KEY is configured, derives key via SHA-256.
 * Otherwise, persists/reads a secure random key file in HACM_STATE_DIR/app.key.
 */
export function resolveAppKey(
  config:
    AppKeyConfig | Pick<ServerConfig, 'HACM_SECRET_KEY' | 'HACM_STATE_DIR'>,
): Buffer {
  if (config.HACM_SECRET_KEY && config.HACM_SECRET_KEY.length >= 32) {
    return crypto
      .createHash('sha256')
      .update(config.HACM_SECRET_KEY, 'utf8')
      .digest();
  }

  const keyFilePath = path.join(config.HACM_STATE_DIR, 'app.key');

  if (fs.existsSync(keyFilePath)) {
    const content = fs.readFileSync(keyFilePath, 'utf8').trim();
    if (content.length === 64) {
      return Buffer.from(content, 'hex');
    }
    const raw = fs.readFileSync(keyFilePath);
    if (raw.length === 32) {
      return raw;
    }
  }

  // Key file does not exist or has invalid length - generate a new 256-bit key
  fs.mkdirSync(config.HACM_STATE_DIR, { recursive: true });
  const newKey = crypto.randomBytes(32);
  fs.writeFileSync(keyFilePath, newKey.toString('hex'), { mode: 0o600 });
  return newKey;
}

/**
 * Encrypts a plaintext secret with AES-256-GCM.
 * Format: v1:<ivHex>:<tagHex>:<cipherHex>
 */
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `v1:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts an AES-256-GCM payload formatted as v1:<ivHex>:<tagHex>:<cipherHex>.
 */
export function decryptSecret(payload: string, key: Buffer): string {
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Unsupported or malformed encrypted secret payload format');
  }

  const ivHex = parts[1];
  const tagHex = parts[2];
  const cipherHex = parts[3];

  if (!ivHex || !tagHex || !cipherHex) {
    throw new Error('Encrypted payload missing required fields');
  }

  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const cipherText = Buffer.from(cipherHex, 'hex');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(cipherText),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

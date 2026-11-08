import { describe, it, expect } from 'vitest';
import {
  base32Encode,
  base32Decode,
  generateTotpSecret,
  generateTotpUri,
  generateTotpQrCode,
  generateHotp,
  generateTotp,
  verifyTotp,
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyRecoveryCodeMatch,
} from './totp.js';

describe('TOTP and recovery codes utilities', () => {
  it('encodes and decodes Base32 buffers accurately', () => {
    const raw = Buffer.from('Hello, World! 123', 'utf8');
    const encoded = base32Encode(raw);
    const decoded = base32Decode(encoded);
    expect(decoded.toString('utf8')).toBe('Hello, World! 123');
  });

  it('throws on invalid base32 characters', () => {
    expect(() => base32Decode('INVALID89')).toThrow('Invalid Base32 character');
  });

  it('generates random Base32 TOTP secrets', () => {
    const secret = generateTotpSecret(20);
    expect(secret).toHaveLength(32);
    expect(/^[A-Z2-7]+$/.test(secret)).toBe(true);
  });

  it('builds standard otpauth URI', () => {
    const uri = generateTotpUri('admin', 'JBSWY3DPEHPK3PXP', 'HAC Manager');
    expect(uri).toBe(
      'otpauth://totp/HAC%20Manager:admin?secret=JBSWY3DPEHPK3PXP&issuer=HAC%20Manager&algorithm=SHA1&digits=6&period=30',
    );
  });

  it('generates a valid QR code data URL', async () => {
    const uri = generateTotpUri('admin', 'JBSWY3DPEHPK3PXP');
    const dataUrl = await generateTotpQrCode(uri);
    expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('generates and verifies TOTP codes across standard windows', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const now = 1700000000000; // Fixed timestamp

    const code = generateTotp(secret, now);
    expect(code).toHaveLength(6);
    expect(/^\d{6}$/.test(code)).toBe(true);

    // Matches at exact time
    expect(verifyTotp(secret, code, { timestampMs: now })).toBe(true);

    // Matches within 30s drift window (previous step)
    expect(verifyTotp(secret, code, { timestampMs: now + 30_000 })).toBe(true);

    // Matches within 30s drift window (next step)
    expect(verifyTotp(secret, code, { timestampMs: now - 30_000 })).toBe(true);

    // Fails beyond window (e.g. 90s later)
    expect(
      verifyTotp(secret, code, { timestampMs: now + 90_000, window: 1 }),
    ).toBe(false);

    // Rejects invalid token formats
    expect(verifyTotp(secret, '12345', { timestampMs: now })).toBe(false);
    expect(verifyTotp(secret, 'abc123', { timestampMs: now })).toBe(false);
    expect(verifyTotp('INVALID89', code, { timestampMs: now })).toBe(false);
  });

  it('matches RFC 4226 HOTP test vector', () => {
    // RFC 4226 Appendix D test vector for secret "12345678901234567890"
    const secret = Buffer.from('12345678901234567890', 'ascii');
    // HOTP values for counter 0..2
    expect(generateHotp(secret, 0)).toBe('755224');
    expect(generateHotp(secret, 1)).toBe('287082');
    expect(generateHotp(secret, 2)).toBe('359152');
  });

  it('generates, hashes and verifies recovery codes', () => {
    const codes = generateRecoveryCodes(8);
    expect(codes).toHaveLength(8);

    const first = codes[0]!;
    expect(first).toMatch(/^[a-f0-9]{6}-[a-f0-9]{6}$/);

    const hashed = hashRecoveryCode(first);
    expect(hashed).toHaveLength(64);

    expect(verifyRecoveryCodeMatch(first, hashed)).toBe(true);
    // Case-insensitive & whitespace tolerant
    expect(verifyRecoveryCodeMatch(first.toUpperCase(), hashed)).toBe(true);
    expect(verifyRecoveryCodeMatch(`  ${first} `, hashed)).toBe(true);

    // Wrong code fails
    expect(verifyRecoveryCodeMatch('000000-000000', hashed)).toBe(false);
    expect(verifyRecoveryCodeMatch('000000-000000', 'short-hash')).toBe(false);
  });
});

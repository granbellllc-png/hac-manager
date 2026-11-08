import crypto from 'node:crypto';
import QRCode from 'qrcode';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Encodes a buffer into RFC 4648 Base32 string (without padding).
 */
export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i] ?? 0;
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

/**
 * Decodes an RFC 4648 Base32 string into a Buffer.
 */
export function base32Decode(input: string): Buffer {
  const cleaned = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i] ?? '';
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) {
      throw new Error(`Invalid Base32 character: ${char}`);
    }
    value = (value << 5) | idx;
    bits += 5;

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

/**
 * Generates a cryptographically random Base32 secret for TOTP (default 160 bits / 20 bytes).
 */
export function generateTotpSecret(byteLength = 20): string {
  return base32Encode(crypto.randomBytes(byteLength));
}

/**
 * Constructs an otpauth:// URI for authenticator app enrollment.
 */
export function generateTotpUri(
  username: string,
  base32Secret: string,
  issuer = 'HAC Manager',
): string {
  const encodedIssuer = encodeURIComponent(issuer);
  const encodedUser = encodeURIComponent(username);
  return `otpauth://totp/${encodedIssuer}:${encodedUser}?secret=${base32Secret}&issuer=${encodedIssuer}&algorithm=SHA1&digits=6&period=30`;
}

/**
 * Generates a PNG data URL (data:image/png;base64,...) of the QR code for enrollment.
 */
export async function generateTotpQrCode(otpauthUri: string): Promise<string> {
  return QRCode.toDataURL(otpauthUri, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 256,
  });
}

/**
 * Computes an RFC 4226 HOTP value for a given counter.
 */
export function generateHotp(secret: Buffer, counter: number): string {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const hmac = crypto.createHmac('sha1', secret);
  hmac.update(counterBuffer);
  const digest = hmac.digest();

  const lastByte = digest[digest.length - 1] ?? 0;
  const offset = lastByte & 0x0f;
  const byte0 = digest[offset] ?? 0;
  const byte1 = digest[offset + 1] ?? 0;
  const byte2 = digest[offset + 2] ?? 0;
  const byte3 = digest[offset + 3] ?? 0;

  const binary =
    ((byte0 & 0x7f) << 24) |
    ((byte1 & 0xff) << 16) |
    ((byte2 & 0xff) << 8) |
    (byte3 & 0xff);

  const otp = (binary % 1_000_000).toString().padStart(6, '0');
  return otp;
}

/**
 * Generates a 6-digit TOTP code for a given timestamp.
 */
export function generateTotp(
  base32Secret: string,
  timestampMs = Date.now(),
  stepSeconds = 30,
): string {
  const secretBuffer = base32Decode(base32Secret);
  const counter = Math.floor(timestampMs / 1000 / stepSeconds);
  return generateHotp(secretBuffer, counter);
}

/**
 * Verifies a 6-digit TOTP code with time drift window tolerance (default +-1 step / +-30s).
 */
export function verifyTotp(
  base32Secret: string,
  token: string,
  options?: { window?: number; timestampMs?: number; stepSeconds?: number },
): boolean {
  const cleanToken = token.trim().replace(/\s+/g, '');
  if (!/^\d{6}$/.test(cleanToken)) {
    return false;
  }

  const window = options?.window ?? 1;
  const stepSeconds = options?.stepSeconds ?? 30;
  const now = options?.timestampMs ?? Date.now();
  const currentStep = Math.floor(now / 1000 / stepSeconds);

  let secretBuffer: Buffer;
  try {
    secretBuffer = base32Decode(base32Secret);
  } catch {
    return false;
  }

  const tokenBuf = Buffer.from(cleanToken);

  for (let i = -window; i <= window; i++) {
    const expected = generateHotp(secretBuffer, currentStep + i);
    const expectedBuf = Buffer.from(expected);
    if (
      expectedBuf.length === tokenBuf.length &&
      crypto.timingSafeEqual(expectedBuf, tokenBuf)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Generates a set of cryptographically random, human-friendly recovery codes (format: xxxx-xxxx).
 */
export function generateRecoveryCodes(count = 8): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const part1 = crypto.randomBytes(3).toString('hex');
    const part2 = crypto.randomBytes(3).toString('hex');
    codes.push(`${part1}-${part2}`);
  }
  return codes;
}

/**
 * Hashes a recovery code for secure database storage.
 */
export function hashRecoveryCode(code: string): string {
  const normalized = code
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * Verifies whether a candidate recovery code matches a stored hash in constant time.
 */
export function verifyRecoveryCodeMatch(
  rawCode: string,
  hashedCode: string,
): boolean {
  const candidateHash = hashRecoveryCode(rawCode);
  const candidateBuf = Buffer.from(candidateHash, 'hex');
  const storedBuf = Buffer.from(hashedCode, 'hex');

  if (candidateBuf.length !== storedBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(candidateBuf, storedBuf);
}

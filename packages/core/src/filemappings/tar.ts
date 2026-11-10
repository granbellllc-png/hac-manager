import { gzipSync } from 'node:zlib';

const BLOCK_SIZE = 512;
const NAME_LENGTH = 100;
const PREFIX_LENGTH = 155;

export interface TarEntry {
  /** Path inside the archive, using forward slashes. */
  readonly name: string;
  readonly content: Uint8Array;
  /** Octal mode, for example `0644`. */
  readonly mode?: string | undefined;
  readonly uid?: number | undefined;
  readonly gid?: number | undefined;
  readonly mtime?: Date | undefined;
}

export class TarArchiveError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'TarArchiveError';
  }
}

function writeString(
  buffer: Buffer,
  offset: number,
  length: number,
  value: string,
): void {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.length > length) {
    throw new TarArchiveError(
      `Value '${value}' does not fit in a ${length}-byte tar header field.`,
    );
  }
  encoded.copy(buffer, offset);
}

function writeOctal(
  buffer: Buffer,
  offset: number,
  length: number,
  value: number,
): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TarArchiveError(`Tar value '${value}' is not a safe integer.`);
  }
  const text = value.toString(8);
  if (text.length > length - 1) {
    throw new TarArchiveError(
      `Tar value '${value}' does not fit in a ${length}-byte octal field.`,
    );
  }
  buffer.write(text.padStart(length - 1, '0'), offset, 'ascii');
  buffer[offset + length - 1] = 0;
}

function splitName(name: string): {
  readonly name: string;
  readonly prefix: string;
} {
  if (Buffer.byteLength(name, 'utf8') <= NAME_LENGTH) {
    return { name, prefix: '' };
  }
  let index = name.lastIndexOf('/');
  while (index > 0) {
    const prefix = name.slice(0, index);
    const base = name.slice(index + 1);
    if (
      Buffer.byteLength(prefix, 'utf8') <= PREFIX_LENGTH &&
      Buffer.byteLength(base, 'utf8') <= NAME_LENGTH
    ) {
      return { name: base, prefix };
    }
    index = name.lastIndexOf('/', index - 1);
  }
  throw new TarArchiveError(
    `Tar entry name '${name}' is too long, even with a ustar prefix.`,
  );
}

function parseMode(mode: string | undefined): number {
  if (mode === undefined) return 0o644;
  if (!/^[0-7]{3,4}$/.test(mode)) {
    throw new TarArchiveError(`Tar mode '${mode}' is not octal.`);
  }
  return Number.parseInt(mode, 8);
}

function header(entry: TarEntry): Buffer {
  const buffer = Buffer.alloc(BLOCK_SIZE);
  const { name, prefix } = splitName(entry.name);
  writeString(buffer, 0, NAME_LENGTH, name);
  writeOctal(buffer, 100, 8, parseMode(entry.mode));
  writeOctal(buffer, 108, 8, entry.uid ?? 0);
  writeOctal(buffer, 116, 8, entry.gid ?? 0);
  writeOctal(buffer, 124, 12, entry.content.byteLength);
  writeOctal(
    buffer,
    136,
    12,
    Math.floor((entry.mtime ?? new Date()).getTime() / 1000),
  );
  buffer.fill(0x20, 148, 156);
  buffer[156] = '0'.charCodeAt(0);
  writeString(buffer, 257, 6, 'ustar\0');
  writeString(buffer, 263, 2, '00');
  writeString(buffer, 345, PREFIX_LENGTH, prefix);

  let checksum = 0;
  for (const byte of buffer) checksum += byte;
  buffer.write(checksum.toString(8).padStart(6, '0'), 148, 'ascii');
  buffer[154] = 0;
  buffer[155] = 0x20;
  return buffer;
}

/**
 * Build a ustar archive from regular files. Directories are created by tar on
 * extraction, so the sync does not need one command per source file.
 */
export function buildTarArchive(entries: readonly TarEntry[]): Uint8Array {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    blocks.push(header(entry));
    blocks.push(Buffer.from(entry.content));
    const remainder = entry.content.byteLength % BLOCK_SIZE;
    if (remainder !== 0) {
      blocks.push(Buffer.alloc(BLOCK_SIZE - remainder));
    }
  }
  blocks.push(Buffer.alloc(BLOCK_SIZE * 2));
  return Buffer.concat(blocks);
}

/** Build a gzip-compressed tar archive for one bulk transfer. */
export function buildTarGz(entries: readonly TarEntry[]): Uint8Array {
  return gzipSync(buildTarArchive(entries));
}

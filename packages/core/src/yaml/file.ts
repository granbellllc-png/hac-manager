import type { Document } from 'yaml';
import { dumpYamlDocument, loadYamlDocument } from './document.js';

export interface FileStat {
  readonly mode: number;
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface FileSystem {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  /** Optional binary read used to hash archives and other non-UTF-8 files. */
  readBinary?(path: string): Promise<Uint8Array>;
  writeFile(
    path: string,
    content: string,
    options?: {
      readonly mode?: number | undefined;
      readonly encoding?: 'utf8';
    },
  ): Promise<void>;
  stat(path: string): Promise<FileStat>;
  readdir(path: string): Promise<string[]>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export const defaultNodeFileSystem: FileSystem = {
  async readFile(path, encoding) {
    const fs = await import('node:fs/promises');
    return fs.readFile(path, encoding);
  },
  async readBinary(path) {
    const fs = await import('node:fs/promises');
    return fs.readFile(path);
  },
  async writeFile(path, content, options) {
    const fs = await import('node:fs/promises');
    return fs.writeFile(path, content, options);
  },
  async stat(path) {
    const fs = await import('node:fs/promises');
    return fs.stat(path);
  },
  async readdir(path) {
    const fs = await import('node:fs/promises');
    return fs.readdir(path);
  },
  async rename(oldPath, newPath) {
    const fs = await import('node:fs/promises');
    return fs.rename(oldPath, newPath);
  },
  async unlink(path) {
    const fs = await import('node:fs/promises');
    return fs.unlink(path);
  },
};

export interface ReadYamlFileResult {
  readonly document: Document;
  readonly raw: string;
  readonly eol: '\n' | '\r\n';
  readonly mode: number;
}

export async function readYamlFile(
  filePath: string,
  fs: FileSystem = defaultNodeFileSystem,
): Promise<ReadYamlFileResult> {
  const [raw, fileStat] = await Promise.all([
    fs.readFile(filePath, 'utf8'),
    fs.stat(filePath),
  ]);
  const eol: '\n' | '\r\n' = raw.includes('\r\n') ? '\r\n' : '\n';
  const document = loadYamlDocument(raw);
  return { document, raw, eol, mode: fileStat.mode };
}

export interface WriteYamlFileOptions {
  readonly atomic?: boolean;
  readonly eol?: '\n' | '\r\n';
  readonly mode?: number;
  readonly fs?: FileSystem;
}

export async function writeYamlFile(
  filePath: string,
  document: Document,
  options?: WriteYamlFileOptions,
): Promise<void> {
  const dumpOptions =
    options?.eol !== undefined ? { eol: options.eol } : undefined;
  const content = dumpYamlDocument(document, dumpOptions);
  const atomic = options?.atomic ?? true;
  const fs = options?.fs ?? defaultNodeFileSystem;

  if (!atomic) {
    await fs.writeFile(filePath, content, {
      mode: options?.mode,
      encoding: 'utf8',
    });
    return;
  }

  const tempFile = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;

  try {
    await fs.writeFile(tempFile, content, {
      mode: options?.mode,
      encoding: 'utf8',
    });
    await fs.rename(tempFile, filePath);
  } catch (error) {
    await fs.unlink(tempFile).catch(() => undefined);
    throw error;
  }
}

import type { Document } from 'yaml';
import {
  defaultNodeFileSystem,
  writeYamlFile,
  type FileSystem,
  type WriteYamlFileOptions,
} from '../yaml/file.js';
import { hashContent } from './hash.js';

export class WriteConflictError extends Error {
  public constructor(
    public readonly path: string,
    public readonly expectedHash: string,
    public readonly currentHash: string,
  ) {
    super(
      `Write conflict on "${path}": file was modified externally (expected hash ${expectedHash}, current hash ${currentHash}). Overwrite refused.`,
    );
    this.name = 'WriteConflictError';
  }
}

export class WriteGuard {
  private readonly hashes = new Map<string, string>();

  public registerHash(path: string, hash: string): void {
    this.hashes.set(path, hash);
  }

  public getHash(path: string): string | undefined {
    return this.hashes.get(path);
  }

  public clear(): void {
    this.hashes.clear();
  }

  public async assertCanWrite(
    filePath: string,
    expectedHash: string,
    fs: FileSystem = defaultNodeFileSystem,
  ): Promise<string> {
    let currentContent: string;
    try {
      currentContent = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'ENOENT') {
        if (expectedHash !== '') {
          throw new WriteConflictError(filePath, expectedHash, '<deleted>');
        }
        return '';
      }
      throw error;
    }

    const currentHash = await hashContent(currentContent);
    if (expectedHash !== currentHash) {
      throw new WriteConflictError(filePath, expectedHash, currentHash);
    }

    return currentHash;
  }

  public async writeWithGuard(
    filePath: string,
    document: Document,
    expectedHash: string,
    fs: FileSystem = defaultNodeFileSystem,
    options?: WriteYamlFileOptions,
  ): Promise<{ readonly newHash: string }> {
    await this.assertCanWrite(filePath, expectedHash, fs);

    await writeYamlFile(filePath, document, { ...options, fs });
    const writtenContent = await fs.readFile(filePath, 'utf8');
    const newHash = await hashContent(writtenContent);
    this.registerHash(filePath, newHash);

    return { newHash };
  }
}

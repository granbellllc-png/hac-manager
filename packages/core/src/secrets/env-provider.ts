import { defaultNodeFileSystem, type FileSystem } from '../yaml/file.js';

export function parseDotenv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const cleanLine = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eqIdx = cleanLine.indexOf('=');
    if (eqIdx === -1) continue;

    const key = cleanLine.slice(0, eqIdx).trim();
    let val = cleanLine.slice(eqIdx + 1).trim();

    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      const quote = val[0];
      val = val.slice(1, -1);
      if (quote === '"') {
        val = val
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"');
      }
    } else {
      // Inline comment stripping for unquoted values
      const hashIdx = val.indexOf('#');
      if (hashIdx !== -1) {
        val = val.slice(0, hashIdx).trim();
      }
    }

    if (key.length > 0) {
      result[key] = val;
    }
  }

  return result;
}

export interface EnvSecretProviderOptions {
  readonly env?: Record<string, string | undefined> | undefined;
  readonly fs?: FileSystem | undefined;
}

export class EnvSecretProvider {
  private readonly baseEnv: Record<string, string | undefined>;
  private readonly fs: FileSystem;
  private readonly fileCache = new Map<string, Record<string, string>>();

  public constructor(options: EnvSecretProviderOptions = {}) {
    this.baseEnv = options.env ?? process.env;
    this.fs = options.fs ?? defaultNodeFileSystem;
  }

  public async loadEnvFile(filePath: string): Promise<Record<string, string>> {
    const cached = this.fileCache.get(filePath);
    if (cached) return cached;

    try {
      const content = await this.fs.readFile(filePath, 'utf8');
      const parsed = parseDotenv(content);
      this.fileCache.set(filePath, parsed);
      return parsed;
    } catch {
      return {};
    }
  }

  public async resolveVar(
    varName: string,
    fileDirs?: readonly string[],
  ): Promise<string | undefined> {
    if (fileDirs && fileDirs.length > 0) {
      for (const dir of fileDirs) {
        const envPath = `${dir.replace(/[/\\]+$/, '')}/.env`;
        const dict = await this.loadEnvFile(envPath);
        if (dict[varName] !== undefined) {
          return dict[varName];
        }
      }
    }

    return this.baseEnv[varName];
  }

  public invalidateFile(filePath: string): void {
    this.fileCache.delete(filePath);
  }

  public clear(): void {
    this.fileCache.clear();
  }
}

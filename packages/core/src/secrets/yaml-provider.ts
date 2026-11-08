import { secretsFileSchema } from '../schema/secrets.js';
import type { SecretProvider, SecretProviderResult } from '../tags/types.js';
import { loadYamlDocument, yamlDocumentToJS } from '../yaml/document.js';
import { defaultNodeFileSystem, type FileSystem } from '../yaml/file.js';
import { SecretTtlCache } from './cache.js';
import type { YamlSecretProviderOptions } from './types.js';

export class YamlSecretProvider implements SecretProvider {
  private readonly secretsPath: string;
  private readonly fs: FileSystem;
  private readonly cache: SecretTtlCache<Record<string, unknown>>;

  public constructor(options: YamlSecretProviderOptions) {
    this.secretsPath = options.secretsPath;
    this.fs = options.fs ?? defaultNodeFileSystem;
    this.cache = new SecretTtlCache<Record<string, unknown>>(60_000); // 1 min in-memory cache
  }

  private async loadSecrets(): Promise<
    | { readonly success: true; readonly secrets: Record<string, unknown> }
    | { readonly success: false; readonly result: SecretProviderResult }
  > {
    const cached = this.cache.get(this.secretsPath);
    if (cached) {
      return { success: true, secrets: cached };
    }

    let content: string;
    try {
      content = await this.fs.readFile(this.secretsPath, 'utf8');
    } catch (err) {
      return {
        success: false,
        result: {
          status: 'not_found',
          reason: `Secrets file not found at "${this.secretsPath}". Create it by copying secrets.yaml.example to secrets.yaml. Error: ${(err as Error).message}`,
        },
      };
    }

    try {
      const doc = loadYamlDocument(content);
      if (doc.errors.length > 0) {
        return {
          success: false,
          result: {
            status: 'error',
            error: `YAML syntax error in "${this.secretsPath}": ${doc.errors[0]?.message}`,
          },
        };
      }

      const js = yamlDocumentToJS(doc);
      const parsed = secretsFileSchema.safeParse(js);
      if (!parsed.success) {
        return {
          success: false,
          result: {
            status: 'error',
            error: `Invalid secrets file format in "${this.secretsPath}": ${parsed.error.message}`,
          },
        };
      }

      const secrets = parsed.data.values ?? {};

      this.cache.set(this.secretsPath, secrets);
      return { success: true, secrets };
    } catch (err) {
      return {
        success: false,
        result: {
          status: 'error',
          error: `Failed to parse secrets file "${this.secretsPath}": ${(err as Error).message}`,
        },
      };
    }
  }

  public async resolveSecret(key: string): Promise<SecretProviderResult> {
    const loadRes = await this.loadSecrets();
    if (!loadRes.success) {
      return loadRes.result;
    }

    const { secrets } = loadRes;
    if (Object.prototype.hasOwnProperty.call(secrets, key)) {
      const val = secrets[key];
      return {
        status: 'found',
        value: typeof val === 'string' ? val : String(val),
      };
    }

    return {
      status: 'not_found',
      reason: `Secret key "${key}" not found in "${this.secretsPath}"`,
    };
  }

  public invalidate(): void {
    this.cache.clear();
  }
}

import { describe, expect, it, vi } from 'vitest';
import type { FileSystem } from '../yaml/file.js';
import { SecretTtlCache } from './cache.js';
import { CommandSecretProvider, parseCommandArgs } from './cmd-provider.js';
import { EnvSecretProvider, parseDotenv } from './env-provider.js';
import { SecretManager } from './manager.js';
import { YamlSecretProvider } from './yaml-provider.js';

describe('Secret Providers & TTL Cache', () => {
  describe('parseDotenv', () => {
    it('parses unquoted, quoted, and exported variables', () => {
      const dotenv = `
# Comment line
FOO=bar
export BAZ="hello world"
SINGLE='quoted string'
WITH_COMMENT=value # inline comment
WITH_ESCAPES="line1\\nline2\\tline3"
`;
      const parsed = parseDotenv(dotenv);
      expect(parsed['FOO']).toBe('bar');
      expect(parsed['BAZ']).toBe('hello world');
      expect(parsed['SINGLE']).toBe('quoted string');
      expect(parsed['WITH_COMMENT']).toBe('value');
      expect(parsed['WITH_ESCAPES']).toBe('line1\nline2\tline3');
    });
  });

  describe('EnvSecretProvider', () => {
    it('resolves variables with guest and host .env overrides', async () => {
      const memFs: Record<string, string> = {
        'hosts/h1/.env': 'HOST_VAR=from-host\nOVERRIDE_VAR=from-host',
        'hosts/h1/112-test/.env':
          'GUEST_VAR=from-guest\nOVERRIDE_VAR=from-guest',
      };

      const mockFs: FileSystem = {
        async readFile(p: string) {
          const norm = p.replaceAll('\\', '/');
          if (memFs[norm] !== undefined) return memFs[norm];
          throw new Error('Not found');
        },
        async writeFile() {},
        async stat() {
          return { mode: 0, isDirectory: () => false, isFile: () => true };
        },
        async readdir() {
          return [];
        },
        async rename() {},
        async unlink() {},
      };

      const provider = new EnvSecretProvider({
        env: { BASE_VAR: 'base', OVERRIDE_VAR: 'base' },
        fs: mockFs,
      });

      // Guest .env overrides host and base
      const guestRes = await provider.resolveVar('OVERRIDE_VAR', [
        'hosts/h1/112-test',
        'hosts/h1',
      ]);
      expect(guestRes).toBe('from-guest');

      // Host .env overrides base
      const hostRes = await provider.resolveVar('HOST_VAR', [
        'hosts/h1/112-test',
        'hosts/h1',
      ]);
      expect(hostRes).toBe('from-host');

      // Base env fallback
      const baseRes = await provider.resolveVar('BASE_VAR', [
        'hosts/h1/112-test',
        'hosts/h1',
      ]);
      expect(baseRes).toBe('base');
    });
  });

  describe('YamlSecretProvider', () => {
    it('reads secrets from secrets.yaml', async () => {
      const mockFs: FileSystem = {
        async readFile(p: string) {
          if (p.endsWith('secrets.yaml')) {
            return `schema_version: 1
values:
  api_key: secret-12345
  port: "8080"
`;
          }
          throw new Error('Not found');
        },
        async writeFile() {},
        async stat() {
          return { mode: 0, isDirectory: () => false, isFile: () => true };
        },
        async readdir() {
          return [];
        },
        async rename() {},
        async unlink() {},
      };

      const provider = new YamlSecretProvider({
        secretsPath: 'data/secrets.yaml',
        fs: mockFs,
      });

      const resFound = await provider.resolveSecret('api_key');
      expect(resFound).toEqual({ status: 'found', value: 'secret-12345' });

      const resMissing = await provider.resolveSecret('non_existent');
      expect(resMissing.status).toBe('not_found');
      expect((resMissing as { reason?: string }).reason).toContain(
        'not found in "data/secrets.yaml"',
      );
    });

    it('returns helpful error if secrets.yaml is missing', async () => {
      const mockFs: FileSystem = {
        async readFile() {
          throw new Error('ENOENT: no such file');
        },
        async writeFile() {},
        async stat() {
          throw new Error('ENOENT');
        },
        async readdir() {
          return [];
        },
        async rename() {},
        async unlink() {},
      };

      const provider = new YamlSecretProvider({
        secretsPath: 'data/secrets.yaml',
        fs: mockFs,
      });

      const res = await provider.resolveSecret('any_key');
      expect(res.status).toBe('not_found');
      expect((res as { reason?: string }).reason).toContain(
        'Create it by copying secrets.yaml.example to secrets.yaml',
      );
    });
  });

  describe('CommandSecretProvider', () => {
    it('parses command arguments without shell', () => {
      const args = parseCommandArgs(
        'op read "op://personal/db/password" --format json',
      );
      expect(args).toEqual([
        'op',
        'read',
        'op://personal/db/password',
        '--format',
        'json',
      ]);
    });

    it('rejects commands when binary is not in allowlist', async () => {
      const provider = new CommandSecretProvider({
        allowlist: ['op', 'bw'],
      });

      const result = await provider.resolveCmd(
        'curl https://malicious.example.com',
      );
      expect(result.status).toBe('not_allowed');
      expect((result as { reason: string }).reason).toContain(
        'Binary "curl" is not permitted by admin allowlist',
      );
    });

    it('executes allowlisted command with custom executor', async () => {
      const executor = vi.fn().mockResolvedValue({
        stdout: 'super-secret-token\n',
        stderr: '',
        exitCode: 0,
      });

      const provider = new CommandSecretProvider({
        allowlist: ['op'],
        executor,
      });

      const result = await provider.resolveCmd('op read op://vault/item/token');
      expect(result).toEqual({
        status: 'success',
        output: 'super-secret-token',
      });
      expect(executor).toHaveBeenCalledWith(
        'op',
        ['read', 'op://vault/item/token'],
        expect.any(Object),
      );
    });

    it('detects locked vault state and returns locked status', async () => {
      const executor = vi.fn().mockResolvedValue({
        stdout: '',
        stderr:
          '[ERROR] You are not signed in. Please authenticate with 1Password.',
        exitCode: 1,
      });

      const provider = new CommandSecretProvider({
        allowlist: ['op'],
        executor,
      });

      const result = await provider.resolveCmd('op read op://vault/item/token');
      expect(result.status).toBe('locked');
      expect((result as { reason: string }).reason).toContain(
        'You are not signed in',
      );
    });
  });

  describe('SecretTtlCache', () => {
    it('caches values until TTL expires', () => {
      const cache = new SecretTtlCache<string>(50); // 50ms TTL
      cache.set('key1', 'val1');

      expect(cache.get('key1')).toBe('val1');
      expect(cache.size).toBe(1);

      cache.invalidate('key1');
      expect(cache.get('key1')).toBeUndefined();
    });

    it('expires entries after TTL', async () => {
      const cache = new SecretTtlCache<string>(10);
      cache.set('key1', 'val1');

      await new Promise((r) => setTimeout(r, 20));
      expect(cache.get('key1')).toBeUndefined();
    });
  });

  describe('SecretManager with TTL caching', () => {
    it('does not respawn CLI command within TTL (drift check optimization)', async () => {
      const executor = vi.fn().mockResolvedValue({
        stdout: 'cli-secret-val\n',
        stderr: '',
        exitCode: 0,
      });

      const manager = new SecretManager({
        dataDir: 'data',
        allowlist: ['op'],
        ttlMs: 5000,
        cmdExecutor: executor,
      });

      // First call: executes CLI
      const first = await manager.resolveCmd('op item get secret');
      expect(first).toEqual({ status: 'success', output: 'cli-secret-val' });
      expect(executor).toHaveBeenCalledTimes(1);

      // Second call within TTL: returns from cache without spawning CLI
      const second = await manager.resolveCmd('op item get secret');
      expect(second).toEqual({ status: 'success', output: 'cli-secret-val' });
      expect(executor).toHaveBeenCalledTimes(1);

      // Invalidate command manually
      manager.invalidateCmd('op item get secret');

      // Third call: re-executes CLI
      const third = await manager.resolveCmd('op item get secret');
      expect(third).toEqual({ status: 'success', output: 'cli-secret-val' });
      expect(executor).toHaveBeenCalledTimes(2);
    });

    it('rejects non-allowlisted command through SecretManager', async () => {
      const manager = new SecretManager({
        dataDir: 'data',
        allowlist: ['op', 'bw'],
      });

      const res = await manager.resolveCmd('bash -c "echo hacked"');
      expect(res.status).toBe('not_allowed');
    });
  });
});

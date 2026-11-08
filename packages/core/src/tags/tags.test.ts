import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TagValue } from '../schema/common.js';
import { loadYamlDocument, yamlDocumentToJS } from '../yaml/document.js';
import type { FileSystem } from '../yaml/file.js';
import {
  type CmdProvider,
  resolveConfigTags,
  resolveSandboxedInclude,
  resolveTag,
  Secret,
  type SecretProvider,
} from './index.js';

const testDataDir = resolve('/mock-data').replace(/\\/g, '/');

describe('Lazy Tag Resolution Engine with Sandboxed !include', () => {
  const mockCmdProvider: CmdProvider = {
    resolveCmd: (cmd: string) => {
      if (cmd === "op read 'op://Homelab/pass'") {
        return { status: 'success', output: 'op-token-999' };
      }
      if (cmd === 'bw get password my-entry') {
        return { status: 'locked', reason: 'Bitwarden CLI session is locked' };
      }
      if (cmd.startsWith('curl')) {
        return {
          status: 'not_allowed',
          reason: 'curl is not in the admin allowlist',
        };
      }
      if (cmd === 'faulty') {
        return { status: 'error', error: 'Command exited with status 1' };
      }
      return { status: 'error', error: 'Unknown command' };
    },
  };
  describe('Secret Type Invariants', () => {
    it('wraps sensitive credentials and masks in all string representations', () => {
      const secret = new Secret('super-sensitive-token-12345');

      expect(secret.unwrap()).toBe('super-sensitive-token-12345');
      expect(secret.toJSON()).toBe('***');
      expect(secret.toString()).toBe('***');
      expect(String(secret)).toBe('***');
      expect(JSON.stringify({ token: secret })).toBe('{"token":"***"}');
      expect(
        (secret as unknown as Record<symbol, () => string>)[
          Symbol.for('nodejs.util.inspect.custom')
        ]?.(),
      ).toBe('[Secret: ***]');
    });

    it('compares secrets safely by hash without leaking plaintext', () => {
      const sec1 = new Secret('password-A');
      const sec2 = new Secret('password-A');
      const sec3 = new Secret('password-B');

      expect(sec1.hash).toBe(sec2.hash);
      expect(sec1.equals(sec2)).toBe(true);
      expect(sec1.equals(sec3)).toBe(false);
      expect(sec1.equals('password-A')).toBe(false);
    });

    it('throws when constructing Secret with non-string value', () => {
      expect(() => new Secret(123 as unknown as string)).toThrow(TypeError);
    });
  });

  describe('!env resolution', () => {
    it('resolves environment variables when present', async () => {
      const tag: TagValue = { tag: 'env', value: 'DATABASE_HOST' };
      const res = await resolveTag(tag, {
        dataDir: '/data',
        env: { DATABASE_HOST: 'db.internal.local' },
      });

      expect(res.status).toBe('resolved');
      if (res.status === 'resolved') {
        expect(res.value).toBe('db.internal.local');
        expect(res.tag).toBe('env');
        expect(res.raw).toBe('DATABASE_HOST');
      }
    });

    it('returns unresolved status when environment variable is missing', async () => {
      const tag: TagValue = { tag: 'env', value: 'MISSING_VAR' };
      const res = await resolveTag(tag, {
        dataDir: '/data',
        env: {},
      });

      expect(res.status).toBe('unresolved');
      if (res.status === 'unresolved') {
        expect(res.reason).toContain("Environment variable 'MISSING_VAR'");
      }
    });
  });

  describe('!secret resolution', () => {
    const mockSecretProvider: SecretProvider = {
      resolveSecret: (key: string) => {
        if (key === 'db_pass') {
          return { status: 'found', value: 'secret-db-pass-42' };
        }
        if (key === 'vault_locked_key') {
          return { status: 'locked', reason: 'KeePassXC database is locked' };
        }
        if (key === 'error_key') {
          return {
            status: 'error',
            error: 'Failed to connect to Vault daemon',
          };
        }
        return {
          status: 'not_found',
          reason: `Key '${key}' not in secrets.yaml`,
        };
      },
    };

    it('resolves secret wrapped in Secret class', async () => {
      const tag: TagValue = { tag: 'secret', value: 'db_pass' };
      const res = await resolveTag(tag, {
        dataDir: '/data',
        secretProvider: mockSecretProvider,
      });

      expect(res.status).toBe('resolved');
      if (res.status === 'resolved') {
        expect(res.value).toBeInstanceOf(Secret);
        expect((res.value as Secret).unwrap()).toBe('secret-db-pass-42');
        expect(JSON.stringify({ pass: res.value })).toBe('{"pass":"***"}');
      }
    });

    it('returns locked status when provider is locked', async () => {
      const tag: TagValue = { tag: 'secret', value: 'vault_locked_key' };
      const res = await resolveTag(tag, {
        dataDir: '/data',
        secretProvider: mockSecretProvider,
      });

      expect(res.status).toBe('locked');
      if (res.status === 'locked') {
        expect(res.reason).toBe('KeePassXC database is locked');
      }
    });

    it('returns unresolved status when secret is not found', async () => {
      const tag: TagValue = { tag: 'secret', value: 'non_existent' };
      const res = await resolveTag(tag, {
        dataDir: '/data',
        secretProvider: mockSecretProvider,
      });

      expect(res.status).toBe('unresolved');
      if (res.status === 'unresolved') {
        expect(res.reason).toContain('non_existent');
      }
    });

    it('returns error status when provider reports error or throws', async () => {
      const tag: TagValue = { tag: 'secret', value: 'error_key' };
      const res = await resolveTag(tag, {
        dataDir: '/data',
        secretProvider: mockSecretProvider,
      });

      expect(res.status).toBe('error');

      const throwingProvider: SecretProvider = {
        resolveSecret: () => {
          throw new Error('Connection reset by peer');
        },
      };
      const throwRes = await resolveTag(tag, {
        dataDir: '/data',
        secretProvider: throwingProvider,
      });
      expect(throwRes.status).toBe('error');
    });

    it('returns unresolved status when no secret provider is configured', async () => {
      const tag: TagValue = { tag: 'secret', value: 'any_key' };
      const res = await resolveTag(tag, { dataDir: '/data' });
      expect(res.status).toBe('unresolved');
    });
  });

  describe('!cmd resolution', () => {
    it('resolves command output wrapped in Secret class', async () => {
      const tag: TagValue = {
        tag: 'cmd',
        value: "op read 'op://Homelab/pass'",
      };
      const res = await resolveTag(tag, {
        dataDir: '/data',
        cmdProvider: mockCmdProvider,
      });

      expect(res.status).toBe('resolved');
      if (res.status === 'resolved') {
        expect(res.value).toBeInstanceOf(Secret);
        expect((res.value as Secret).unwrap()).toBe('op-token-999');
        expect(JSON.stringify({ pass: res.value })).toBe('{"pass":"***"}');
      }
    });

    it('returns locked status when cmd provider reports locked vault', async () => {
      const tag: TagValue = { tag: 'cmd', value: 'bw get password my-entry' };
      const res = await resolveTag(tag, {
        dataDir: '/data',
        cmdProvider: mockCmdProvider,
      });
      expect(res.status).toBe('locked');
    });

    it('returns error status when command is disallowed by allowlist', async () => {
      const tag: TagValue = { tag: 'cmd', value: 'curl http://malicious.com' };
      const res = await resolveTag(tag, {
        dataDir: '/data',
        cmdProvider: mockCmdProvider,
      });
      expect(res.status).toBe('error');
      if (res.status === 'error') {
        expect(res.error).toContain('admin allowlist');
      }
    });

    it('returns unresolved status when no cmd provider is configured', async () => {
      const tag: TagValue = { tag: 'cmd', value: 'echo hi' };
      const res = await resolveTag(tag, { dataDir: '/data' });
      expect(res.status).toBe('unresolved');
    });
  });

  describe('!expr resolution', () => {
    it('evaluates safe expression using context', async () => {
      const tag: TagValue = {
        tag: 'expr',
        value: "mac('A2:B1:C1', host.index, net.index, vmid)",
      };
      const res = await resolveTag(tag, {
        dataDir: '/data',
        evaluationContext: {
          host: { index: 1 },
          net: { index: 0 },
          vmid: 112,
        },
      });

      expect(res.status).toBe('resolved');
      if (res.status === 'resolved') {
        expect(res.value).toBe('A2:B1:C1:01:E0:12');
      }
    });

    it('returns error status when expression evaluation fails', async () => {
      const tag: TagValue = { tag: 'expr', value: '1 / 0' };
      const res = await resolveTag(tag, { dataDir: '/data' });
      expect(res.status).toBe('error');
      if (res.status === 'error') {
        expect(res.error).toContain('Division by zero');
      }
    });
  });

  describe('Sandboxed !include Confinement & Security', () => {
    const memoryFiles: Record<string, string> = {
      [`${testDataDir}/common/dns.yaml`]: `
nameservers:
  - 1.1.1.1
  - 8.8.8.8
`,
      [`${testDataDir}/nested/a.yaml`]: `
schema_version: 1
data: !include b.yaml
`,
      [`${testDataDir}/nested/b.yaml`]: `
message: "hello from b"
`,
      [`${testDataDir}/cycle/first.yaml`]: `
loop: !include second.yaml
`,
      [`${testDataDir}/cycle/second.yaml`]: `
loop: !include first.yaml
`,
    };

    const mockFs: FileSystem = {
      readFile: (p: string) => {
        const norm = p.replace(/\\/g, '/');
        if (memoryFiles[norm] !== undefined) {
          return Promise.resolve(memoryFiles[norm]!);
        }
        return Promise.reject(new Error(`File not found: ${p}`));
      },
      writeFile: () => Promise.resolve(),
      stat: () =>
        Promise.resolve({
          mode: 0o644,
          isDirectory: () => false,
          isFile: () => true,
        }),
      readdir: () => Promise.resolve([]),
      rename: () => Promise.resolve(),
      unlink: () => Promise.resolve(),
    };

    it('resolves valid relative !include inside dataDir', async () => {
      const res = await resolveSandboxedInclude(
        'common/dns.yaml',
        testDataDir,
        testDataDir,
        mockFs,
      );

      expect(res.status).toBe('resolved');
      if (res.status === 'resolved') {
        expect(res.value).toEqual({
          nameservers: ['1.1.1.1', '8.8.8.8'],
        });
      }
    });

    it('rejects path traversal attempts with ..', async () => {
      const res = await resolveSandboxedInclude(
        '../etc/passwd',
        testDataDir,
        testDataDir,
        mockFs,
      );

      expect(res.status).toBe('error');
      if (res.status === 'error') {
        expect(res.error).toContain('Path traversal forbidden');
        expect(res.error).toContain('..');
      }
    });

    it('rejects absolute paths resolving outside dataDir', async () => {
      const outsideDir = resolve('/outside-dir').replace(/\\/g, '/');
      const res = await resolveSandboxedInclude(
        'file.yaml',
        testDataDir,
        outsideDir,
        mockFs,
      );

      expect(res.status).toBe('error');
      if (res.status === 'error') {
        expect(res.error).toContain('Path traversal forbidden');
      }
    });

    it('detects and rejects circular includes', async () => {
      const visited = new Set([`${testDataDir}/cycle/first.yaml`]);
      const res = await resolveSandboxedInclude(
        'first.yaml',
        testDataDir,
        `${testDataDir}/cycle`,
        mockFs,
        visited,
      );

      expect(res.status).toBe('error');
      if (res.status === 'error') {
        expect(res.error).toContain('Circular !include detected');
      }
    });

    it('handles file read errors gracefully', async () => {
      const res = await resolveSandboxedInclude(
        'common/missing.yaml',
        testDataDir,
        testDataDir,
        mockFs,
      );

      expect(res.status).toBe('error');
      if (res.status === 'error') {
        expect(res.error).toContain('Failed to load !include');
      }
    });
  });

  describe('resolveConfigTags with raw Document immutability', () => {
    it('resolves all tags in complex config and never mutates the raw document', async () => {
      const yamlText = `schema_version: 1
id: 112
name: web-app
gateway: !env GATEWAY_IP
password: !secret db_password
mac: !expr "mac('A2:B1:C1', host.index, net.index, vmid)"
`;
      const doc = loadYamlDocument(yamlText);
      const rawJS = yamlDocumentToJS(doc);

      const secretProvider: SecretProvider = {
        resolveSecret: (key: string) => {
          if (key === 'db_password')
            return { status: 'found', value: 'super-pass' };
          return { status: 'not_found' };
        },
      };

      const { data: resolved, report } = await resolveConfigTags(rawJS, {
        dataDir: 'D:/data',
        env: { GATEWAY_IP: '192.168.1.1' },
        secretProvider,
        evaluationContext: {
          host: { index: 1 },
          net: { index: 0 },
          vmid: 112,
        },
      });

      expect(report.totalTags).toBe(3);
      expect(report.resolvedCount).toBe(3);
      expect(report.isFullyResolved).toBe(true);

      expect(resolved).toEqual({
        schema_version: 1,
        id: 112,
        name: 'web-app',
        gateway: '192.168.1.1',
        password: expect.any(Secret),
        mac: 'A2:B1:C1:01:E0:12',
      });

      expect(
        ((resolved as Record<string, unknown>).password as Secret).unwrap(),
      ).toBe('super-pass');

      // Verify rawJS and doc remain completely untouched!
      const raw = rawJS as Record<string, unknown>;
      expect(raw.gateway).toEqual({ tag: 'env', value: 'GATEWAY_IP' });
      expect(raw.password).toEqual({ tag: 'secret', value: 'db_password' });
      expect(raw.mac).toEqual({
        tag: 'expr',
        value: "mac('A2:B1:C1', host.index, net.index, vmid)",
      });
      expect(doc.toString()).toBe(yamlText);
    });

    it('accurately reports unresolved, locked, and error tags in report', async () => {
      const input = {
        validEnv: { tag: 'env', value: 'OK_VAR' },
        missingEnv: { tag: 'env', value: 'MISSING_VAR' },
        lockedSecret: { tag: 'secret', value: 'locked_key' },
        brokenExpr: { tag: 'expr', value: '1 / 0' },
      };

      const secretProvider: SecretProvider = {
        resolveSecret: () => ({ status: 'locked', reason: 'Vault is locked' }),
      };

      const { report } = await resolveConfigTags(input, {
        dataDir: 'D:/data',
        env: { OK_VAR: 'ok' },
        secretProvider,
      });

      expect(report.totalTags).toBe(4);
      expect(report.resolvedCount).toBe(1);
      expect(report.isFullyResolved).toBe(false);

      expect(report.unresolved).toHaveLength(1);
      expect(report.unresolved[0]?.raw).toBe('MISSING_VAR');

      expect(report.locked).toHaveLength(1);
      expect(report.locked[0]?.raw).toBe('locked_key');

      expect(report.errors).toHaveLength(1);
      expect(report.errors[0]?.raw).toBe('1 / 0');
    });

    it('recursively resolves nested !includes', async () => {
      const memoryFiles: Record<string, string> = {
        [`${testDataDir}/main.yaml`]: 'sub: !include sub.yaml',
        [`${testDataDir}/sub.yaml`]: 'env_val: !env MY_ENV',
      };

      const mockFs: FileSystem = {
        readFile: (p: string) => {
          const norm = p.replace(/\\/g, '/');
          if (memoryFiles[norm]) return Promise.resolve(memoryFiles[norm]!);
          return Promise.reject(new Error(`Not found: ${p}`));
        },
        writeFile: () => Promise.resolve(),
        stat: () =>
          Promise.resolve({
            mode: 0o644,
            isDirectory: () => false,
            isFile: () => true,
          }),
        readdir: () => Promise.resolve([]),
        rename: () => Promise.resolve(),
        unlink: () => Promise.resolve(),
      };

      const input = {
        included: { tag: 'include', value: 'sub.yaml' },
      };

      const { data, report } = await resolveConfigTags(input, {
        dataDir: testDataDir,
        currentFileDir: testDataDir,
        env: { MY_ENV: 'nested-success' },
        fs: mockFs,
      });

      expect(report.totalTags).toBe(2);
      expect(report.resolvedCount).toBe(2);
      expect(report.isFullyResolved).toBe(true);

      expect(data).toEqual({
        included: {
          env_val: 'nested-success',
        },
      });
    });

    it('resolves arrays, null, undefined, and primitive values in walk', async () => {
      const input = {
        list: [1, null, undefined, { tag: 'env', value: 'ENV_ITEM' }],
        prim: 'string-val',
      };

      const { data, report } = await resolveConfigTags(input, {
        dataDir: testDataDir,
        env: { ENV_ITEM: 'resolved-item' },
      });

      expect(report.totalTags).toBe(1);
      expect(report.resolvedCount).toBe(1);
      expect(data).toEqual({
        list: [1, null, undefined, 'resolved-item'],
        prim: 'string-val',
      });

      const primResult = await resolveConfigTags(42, { dataDir: testDataDir });
      expect(primResult.data).toBe(42);

      const nullResult = await resolveConfigTags(null, {
        dataDir: testDataDir,
      });
      expect(nullResult.data).toBeNull();
    });

    it('handles throwing cmd provider gracefully in resolveTag', async () => {
      const throwingCmdProvider: CmdProvider = {
        resolveCmd: () => {
          throw new Error('Fatal CLI crash');
        },
      };

      const res = await resolveTag(
        { tag: 'cmd', value: 'failing command' },
        { dataDir: testDataDir, cmdProvider: throwingCmdProvider },
      );

      expect(res.status).toBe('error');
      if (res.status === 'error') {
        expect(res.error).toBe('Fatal CLI crash');
      }
    });

    it('handles absolute include path with leading slash inside dataDir', async () => {
      const memoryFiles: Record<string, string> = {
        [`${testDataDir}/common/dns.yaml`]: 'server: 1.1.1.1',
      };
      const mockFs: FileSystem = {
        readFile: (p: string) => {
          const norm = p.replace(/\\/g, '/');
          if (memoryFiles[norm]) return Promise.resolve(memoryFiles[norm]!);
          return Promise.reject(new Error(`Not found: ${p}`));
        },
        writeFile: () => Promise.resolve(),
        stat: () =>
          Promise.resolve({
            mode: 0o644,
            isDirectory: () => false,
            isFile: () => true,
          }),
        readdir: () => Promise.resolve([]),
        rename: () => Promise.resolve(),
        unlink: () => Promise.resolve(),
      };

      const res = await resolveSandboxedInclude(
        '/common/dns.yaml',
        testDataDir,
        testDataDir,
        mockFs,
      );

      expect(res.status).toBe('resolved');
      if (res.status === 'resolved') {
        expect(res.value).toEqual({ server: '1.1.1.1' });
      }

      // Also test with explicit absolute path matching testDataDir
      const resExplicit = await resolveSandboxedInclude(
        `${testDataDir}/common/dns.yaml`,
        testDataDir,
        testDataDir,
        mockFs,
      );
      expect(resExplicit.status).toBe('resolved');
    });

    it('handles cmd provider returning error status in resolveTag', async () => {
      const res = await resolveTag(
        { tag: 'cmd', value: 'faulty' },
        { dataDir: testDataDir, cmdProvider: mockCmdProvider },
      );
      expect(res.status).toBe('error');
      if (res.status === 'error') {
        expect(res.error).toBe('Command exited with status 1');
      }
    });
  });
});

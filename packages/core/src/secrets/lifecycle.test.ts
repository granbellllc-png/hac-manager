import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SecretTtlCache } from './cache.js';
import { CommandSecretProvider, parseCommandArgs } from './cmd-provider.js';
import { EnvSecretProvider, parseDotenv } from './env-provider.js';
import { SecretManager } from './manager.js';
import { YamlSecretProvider } from './yaml-provider.js';

const directories: string[] = [];
async function fixtureDir() {
  const directory = await mkdtemp(join(tmpdir(), 'hacm-secrets-test-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('secret cache and provider lifecycle', () => {
  it('expires individual entries and purges expired entries when inspecting size', () => {
    vi.useFakeTimers();
    const cache = new SecretTtlCache<string>();
    cache.set('long', 'long-lived');
    cache.set('short', 'short-lived', 5);
    vi.advanceTimersByTime(6);
    expect(cache.size).toBe(1);
    expect(cache.get('short')).toBeUndefined();
    expect(cache.get('long')).toBe('long-lived');
    expect(cache.invalidate('absent')).toBe(false);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('ignores incomplete dotenv lines and preserves quoted hash characters', () => {
    expect(
      parseDotenv(
        'invalid\n=empty-key\nexport A="x#y"\nB=\nC=plain\nD=\'single#hash\'',
      ),
    ).toEqual({ A: 'x#y', B: '', C: 'plain', D: 'single#hash' });
  });

  it('refreshes changed dotenv files only after invalidation', async () => {
    const dir = await fixtureDir();
    const file = join(dir, '.env');
    const provider = new EnvSecretProvider({ env: { FALLBACK: 'base' } });
    await writeFile(file, 'VALUE=first');
    expect(await provider.loadEnvFile(file)).toEqual({ VALUE: 'first' });
    await writeFile(file, 'VALUE=second');
    expect(await provider.loadEnvFile(file)).toEqual({ VALUE: 'first' });
    provider.invalidateFile(file);
    expect(await provider.loadEnvFile(file)).toEqual({ VALUE: 'second' });
    provider.clear();
    await writeFile(file, 'VALUE=third');
    expect(await provider.resolveVar('VALUE', [`${dir}/`])).toBe('third');
    expect(await provider.resolveVar('FALLBACK', [])).toBe('base');
    expect(await provider.resolveVar('ABSENT')).toBeUndefined();
    vi.stubEnv('HACM_TEST_ENV_ONLY', 'fixture-env');
    expect(await new EnvSecretProvider().resolveVar('HACM_TEST_ENV_ONLY')).toBe(
      'fixture-env',
    );
  });

  it.each([
    ['syntax', 'values: ['],
    ['schema', 'schema_version: 99\nvalues: {}'],
    ['alias', 'schema_version: 1\nvalues: *missing'],
  ])(
    'reports an invalid %s secrets file without caching it',
    async (_name, content) => {
      const dir = await fixtureDir();
      const path = join(dir, 'secrets.yaml');
      const provider = new YamlSecretProvider({ secretsPath: path });
      await writeFile(path, content);
      expect(await provider.resolveSecret('value')).toMatchObject({
        status: 'error',
      });
      await writeFile(path, 'schema_version: 1\nvalues:\n  value: "123"\n');
      expect(await provider.resolveSecret('value')).toEqual({
        status: 'found',
        value: '123',
      });
    },
  );

  it('invalidates YAML, command, and environment caches without caching failures', async () => {
    const dir = await fixtureDir();
    const secrets = join(dir, 'secrets.yaml');
    const executor = vi.fn().mockResolvedValue({
      stdout: 'command-fixture',
      stderr: '',
      exitCode: 0,
    });
    const manager = new SecretManager({
      dataDir: dir,
      env: { BASE: 'fixture-base' },
      cmdExecutor: executor,
    });
    await writeFile(secrets, 'schema_version: 1\nvalues:\n  key: first\n');
    expect(await manager.resolveSecret('key')).toEqual({
      status: 'found',
      value: 'first',
    });
    await writeFile(secrets, 'schema_version: 1\nvalues:\n  key: second\n');
    expect(await manager.resolveSecret('key')).toEqual({
      status: 'found',
      value: 'first',
    });
    manager.invalidateSecret('key');
    expect(await manager.resolveSecret('key')).toEqual({
      status: 'found',
      value: 'second',
    });
    expect(await manager.resolveSecret('absent')).toMatchObject({
      status: 'not_found',
    });
    expect(await manager.resolveCmd(' echo fixture ')).toMatchObject({
      status: 'success',
    });
    expect(manager.ttlCacheSize).toBe(2);
    expect(await manager.resolveEnvVar('BASE')).toBe('fixture-base');
    expect(manager.env).toBeInstanceOf(EnvSecretProvider);
    manager.invalidateAll();
    expect(manager.ttlCacheSize).toBe(0);
    expect(await manager.resolveCmd('echo fixture')).toMatchObject({
      status: 'success',
    });
    expect(executor).toHaveBeenCalledTimes(2);
  });
});

describe('command provider failure boundaries', () => {
  it.each(['', '   ', '""'])(
    'rejects an empty executable: %j',
    async (command) => {
      const executor = vi.fn();
      expect(
        await new CommandSecretProvider({
          allowlist: ['fixture'],
          executor,
        }).resolveCmd(command),
      ).toMatchObject({ status: 'error' });
      expect(executor).not.toHaveBeenCalled();
    },
  );

  it('preserves shell punctuation as literal arguments', () => {
    expect(
      parseCommandArgs(
        "  fixture  'two words' \"single'quote\" $(literal);end ",
      ),
    ).toEqual(['fixture', 'two words', "single'quote", '$(literal);end']);
  });

  it.each([
    'not logged in',
    'session expired',
    'vault is locked',
    'authentication required',
    'please authenticate',
    'unauthorized',
  ])('classifies a locked CLI response: %s', async (stdout) => {
    const executor = vi
      .fn()
      .mockResolvedValue({ stdout, stderr: '', exitCode: 1 });
    const provider = new CommandSecretProvider({
      allowlist: ['fixture'],
      executor,
    });
    expect(await provider.resolveCmd('fixture get')).toEqual({
      status: 'locked',
      reason: stdout,
    });
  });

  it.each([
    [
      { stdout: 'failure on stdout', stderr: '', exitCode: 2 },
      'failure on stdout',
    ],
    [
      { stdout: '', stderr: 'failure on stderr', exitCode: 2 },
      'failure on stderr',
    ],
    [{ stdout: '', stderr: '', exitCode: 2 }, 'exited with code 2'],
  ])(
    'returns an explicit error for a failed command',
    async (result, message) => {
      const executor = vi.fn().mockResolvedValue(result);
      const provider = new CommandSecretProvider({
        allowlist: ['fixture'],
        executor,
      });
      expect(await provider.resolveCmd('fixture get')).toEqual({
        status: 'error',
        error: expect.stringContaining(message),
      });
    },
  );

  it.each([
    ['vault is locked', 'locked'],
    ['fixture execution failed', 'error'],
  ])('classifies executor rejection %s', async (message, status) => {
    const executor = vi.fn().mockRejectedValue(new Error(message));
    const provider = new CommandSecretProvider({
      allowlist: ['fixture'],
      executor,
    });
    expect(await provider.resolveCmd('fixture get')).toMatchObject({ status });
  });

  it('passes explicit limits and environment to an allowlisted executable', async () => {
    const executor = vi
      .fn()
      .mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 });
    const binary = resolve('fixture-bin');
    const provider = new CommandSecretProvider({
      allowlist: [basename(binary)],
      executor,
      defaultTimeoutMs: 99,
      maxOutputBytes: 128,
      env: { FIXTURE: 'yes' },
    });
    expect(await provider.resolveCmd(`"${binary}" read`)).toEqual({
      status: 'success',
      output: 'ok',
    });
    expect(executor).toHaveBeenCalledWith(binary, ['read'], {
      argv: [binary, 'read'],
      timeoutMs: 99,
      maxOutputBytes: 128,
      env: { FIXTURE: 'yes' },
    });
  });

  it.each([
    ['value', 'success', 'fixture-secret'],
    ['env', 'success', 'fixture-environment'],
    ['failure', 'error', 'fixture command failed'],
    ['large', 'error', undefined],
    ['wait', 'error', undefined],
  ])(
    'runs the bounded local executable fixture: %s',
    async (mode, status, value) => {
      const fixture = resolve(
        import.meta.dirname,
        '../../fixtures/secret-cli.mjs',
      );
      const provider = new CommandSecretProvider({
        allowlist: [process.execPath],
        defaultTimeoutMs: mode === 'wait' ? 100 : 2000,
        maxOutputBytes: 1024,
        env: { HACM_TEST_VALUE: 'fixture-environment' },
      });
      const result = await provider.resolveCmd(
        `"${process.execPath}" "${fixture}" ${mode}`,
      );
      expect(result.status).toBe(status);
      if (value && result.status === 'success')
        expect(result.output).toBe(value);
      if (value && result.status === 'error')
        expect(result.error).toContain(value);
    },
  );
});

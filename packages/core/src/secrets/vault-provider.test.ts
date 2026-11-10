import { describe, expect, it, vi } from 'vitest';
import { globalSecretRedactor } from '../redaction/redactor.js';
import {
  CliVaultProvider,
  commandName,
  createDefaultVaultProviders,
} from './vault-provider.js';

describe('CLI vault providers', () => {
  it('keeps a validated token in memory and removes its redaction registration when cleared', async () => {
    const executor = vi.fn(async (_bin, _args, options) => ({
      stdout: '',
      stderr: '',
      exitCode: options.env?.['FIXTURE_TOKEN'] ? 0 : 1,
    }));
    const provider = new CliVaultProvider({
      id: 'fixture',
      name: 'Fixture Vault',
      commands: ['fixture'],
      tokenEnvVar: 'FIXTURE_TOKEN',
      statusArgv: ['fixture', 'status'],
      tokenLabel: 'Fixture token',
      helpText: 'Fixture help',
      executor,
    });

    expect(await provider.status()).toMatchObject({ status: 'locked' });
    expect(await provider.unlock('fixture-session-token')).toEqual({
      status: 'unlocked',
    });
    expect(provider.environment()).toEqual({
      FIXTURE_TOKEN: 'fixture-session-token',
    });
    expect(globalSecretRedactor.redact('fixture-session-token')).toBe('***');
    provider.clear();
    expect(provider.environment()).toEqual({});
    expect(globalSecretRedactor.redact('fixture-session-token')).toBe(
      'fixture-session-token',
    );
  });

  it('rejects invalid tokens and clears a token that does not unlock the CLI', async () => {
    const provider = new CliVaultProvider({
      id: 'fixture',
      name: 'Fixture Vault',
      commands: ['fixture'],
      tokenEnvVar: 'FIXTURE_TOKEN',
      statusArgv: ['fixture', 'status'],
      tokenLabel: 'Fixture token',
      helpText: 'Fixture help',
      executor: vi.fn(async () => ({
        stdout: '',
        stderr: 'vault is locked for rejected-token',
        exitCode: 1,
      })),
    });

    expect(await provider.unlock('  ')).toMatchObject({ status: 'locked' });
    expect(await provider.unlock('x'.repeat(16 * 1024 + 1))).toMatchObject({
      status: 'locked',
    });
    expect(await provider.unlock('rejected-token')).toEqual({
      status: 'locked',
      reason: 'vault is locked for ***',
    });
    expect(provider.environment()).toEqual({});
  });

  it('classifies missing CLIs and supports provider-specific status evaluation', async () => {
    const executor = vi.fn(async (bin: string) => {
      if (bin === 'op') {
        return { stdout: '', stderr: '', exitCode: 1, errorCode: 'ENOENT' };
      }
      if (bin === 'bw') {
        return {
          stdout: JSON.stringify({ status: 'unauthenticated' }),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: 'missing client token', exitCode: 2 };
    });
    const providers = createDefaultVaultProviders({ executor });
    await expect(providers[0]!.status()).resolves.toEqual({
      status: 'unavailable',
      reason: 'Vault CLI is not installed or is not on PATH',
    });
    await expect(providers[1]!.status()).resolves.toEqual({
      status: 'locked',
      reason: 'Bitwarden CLI status is unauthenticated',
    });
    await expect(providers[2]!.status()).resolves.toEqual({
      status: 'locked',
      reason: 'missing client token',
    });
  });

  it('handles malformed Bitwarden status and validates provider commands', async () => {
    const [op, bw] = createDefaultVaultProviders({
      env: { FIXTURE: 'yes' },
      executor: vi.fn(async (bin, _args, options) => ({
        stdout: bin === 'bw' ? 'not-json' : '',
        stderr: '',
        exitCode: bin === 'bw' ? 3 : options.env?.['FIXTURE'] ? 0 : 1,
      })),
    });
    await expect(op!.status()).resolves.toEqual({ status: 'unlocked' });
    await expect(bw!.status()).resolves.toMatchObject({ status: 'locked' });
    expect(commandName('"C:\\Program Files\\Vault\\op.exe" read item')).toBe(
      'op.exe',
    );
    expect(commandName('   ')).toBeUndefined();
    expect(
      () =>
        new CliVaultProvider({
          id: 'invalid',
          name: 'Invalid',
          commands: [],
          tokenEnvVar: 'INVALID',
          statusArgv: [],
          tokenLabel: 'Token',
          helpText: 'Help',
        }),
    ).toThrow("Vault provider 'invalid' needs a status command");
  });

  it('reports executor timeouts and rejections as unavailable', async () => {
    const timedOut = new CliVaultProvider({
      id: 'timeout',
      name: 'Timeout Vault',
      commands: ['timeout'],
      tokenEnvVar: 'TIMEOUT_TOKEN',
      statusArgv: ['timeout', 'status'],
      tokenLabel: 'Token',
      helpText: 'Help',
      executor: vi.fn(async () => ({
        stdout: '',
        stderr: '',
        exitCode: 1,
        errorCode: 'ETIMEDOUT',
      })),
    });
    await expect(timedOut.status()).resolves.toEqual({
      status: 'unavailable',
      reason: 'Vault CLI status check failed (ETIMEDOUT)',
    });
    const rejected = new CliVaultProvider({
      id: 'rejected',
      name: 'Rejected Vault',
      commands: ['rejected'],
      tokenEnvVar: 'REJECTED_TOKEN',
      statusArgv: ['rejected', 'status'],
      tokenLabel: 'Token',
      helpText: 'Help',
      executor: vi.fn(async () => {
        throw new Error('status command rejected');
      }),
    });
    await expect(rejected.status()).resolves.toEqual({
      status: 'unavailable',
      reason: 'status command rejected',
    });
  });
});

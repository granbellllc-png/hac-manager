import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '@hacm/core';
import type { SshTransport } from '../ssh/types.js';
import { ProxmoxClient } from '../proxmox/client.js';
import { HostConnectionRouter } from './router.js';
import { ChannelUnavailableError } from './types.js';

const ssh = () => new FakeTransport() as unknown as SshTransport;
const api = (fetchFn: typeof fetch) =>
  new ProxmoxClient({
    baseUrl: 'https://fixture.invalid',
    auth: {
      type: 'token',
      tokenId: 'fixture!test',
      tokenSecret: 'fixture-token',
    },
    fetchFn,
  });
afterEach(() => vi.restoreAllMocks());

describe('connection routing failure policy', () => {
  it('fails operations with no channels and exposes channel health', async () => {
    const router = new HostConnectionRouter('fixture');
    expect(router.client).toBeUndefined();
    expect(router.transport).toBeUndefined();
    expect(router.health.ssh.status).toBe('not_configured');
    await expect(router.exec([])).rejects.toBeInstanceOf(
      ChannelUnavailableError,
    );
    await expect(router.readGuestConfig(100, 'vm')).rejects.toBeInstanceOf(
      ChannelUnavailableError,
    );
    await expect(router.powerAction(100, 'vm', 'start')).rejects.toBeInstanceOf(
      ChannelUnavailableError,
    );
    expect((await router.testConnection()).ssh.status).toBe('not_configured');
  });

  it.each([new Error('fixture SSH failure'), 'fixture non-Error failure'])(
    'records SSH failures and propagates them',
    async (error) => {
      const transport = ssh();
      vi.spyOn(transport, 'exec').mockRejectedValue(error);
      const router = new HostConnectionRouter('fixture', {
        sshTransport: transport,
      });
      await expect(router.exec(['id'])).rejects.toBe(error);
      expect(router.health.ssh).toMatchObject({ ok: false, status: 'error' });
      expect((await router.testConnection()).ssh).toMatchObject({
        ok: false,
        status: 'unreachable',
      });
    },
  );

  it('delegates file reads/writes and preserves successful command output', async () => {
    const transport = ssh();
    vi.spyOn(transport, 'exec').mockResolvedValue({
      exitCode: 0,
      stdout: 'fixture',
      stderr: '',
      timedOut: false,
    });
    vi.spyOn(transport, 'readFile').mockResolvedValue('fixture-content');
    const write = vi.spyOn(transport, 'writeFile').mockResolvedValue();
    const router = new HostConnectionRouter('fixture', {
      sshTransport: transport,
    });
    expect(await router.exec(['id'])).toMatchObject({ stdout: 'fixture' });
    expect(await router.readFile('/fixture')).toBe('fixture-content');
    await router.writeFile('/fixture', 'new-content');
    expect(write).toHaveBeenCalledWith('/fixture', 'new-content', undefined);
  });

  it.each(['lxc', 'vm'] as const)(
    'uses API for %s config and power',
    async (type) => {
      const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (url) =>
        Response.json({
          data: String(url).endsWith('/config')
            ? { cores: 2 }
            : 'UPID:fixture:1',
        }),
      );
      const router = new HostConnectionRouter('fixture', {
        apiClient: api(fetchFn),
      });
      expect(await router.readGuestConfig(112, type)).toEqual({
        source: 'api',
        raw: { cores: 2 },
      });
      expect(await router.powerAction(112, type, 'reboot')).toEqual({
        source: 'api',
        upid: 'UPID:fixture:1',
      });
      expect((await router.testConnection()).api?.ok).toBe(true);
    },
  );

  it.each(['lxc', 'vm'] as const)(
    'falls back to SSH for %s power when the API fails',
    async (type) => {
      const transport = ssh();
      const exec = vi.spyOn(transport, 'exec').mockResolvedValue({
        exitCode: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
      });
      const client = api(
        vi
          .fn<typeof fetch>()
          .mockRejectedValue(new Error('fixture API offline')),
      );
      const router = new HostConnectionRouter('fixture', {
        apiClient: client,
        sshTransport: transport,
      });
      expect(await router.powerAction(112, type, 'shutdown')).toEqual({
        source: 'ssh',
      });
      expect(exec).toHaveBeenCalledWith([
        type === 'lxc' ? 'pct' : 'qm',
        'shutdown',
        '112',
      ]);
      expect((await router.testConnection()).api?.status).toBe('unreachable');
      const onlySsh = new HostConnectionRouter('fixture', {
        sshTransport: transport,
      });
      expect(await onlySsh.powerAction(112, type, 'start')).toEqual({
        source: 'ssh',
      });
      expect(await onlySsh.readGuestConfig(112, type)).toEqual({
        source: 'ssh',
        raw: '',
      });
    },
  );

  it.each([new Error('fixture API offline'), 'fixture non-Error API failure'])(
    'propagates API errors when SSH is absent',
    async (error) => {
      const router = new HostConnectionRouter('fixture', {
        apiClient: api(vi.fn<typeof fetch>().mockRejectedValue(error)),
      });
      await expect(router.readGuestConfig(100, 'vm')).rejects.toBe(error);
      await expect(router.powerAction(100, 'vm', 'stop')).rejects.toBe(error);
      expect((await router.testConnection()).api?.status).toBe('unreachable');
    },
  );

  it.each(['fixture stderr', ''])(
    'rejects unsuccessful SSH commands even when a channel connects',
    async (stderr) => {
      const transport = ssh();
      vi.spyOn(transport, 'exec').mockResolvedValue({
        exitCode: 2,
        stdout: '',
        stderr,
        timedOut: false,
      });
      const router = new HostConnectionRouter('fixture', {
        sshTransport: transport,
      });
      await expect(router.readGuestConfig(112, 'vm')).rejects.toThrow(
        stderr || 'exit code 2',
      );
      await expect(router.powerAction(112, 'lxc', 'stop')).rejects.toThrow(
        'Power action',
      );
      expect((await router.testConnection()).ssh).toMatchObject({
        status: 'error',
        error: stderr || 'Exit code 2',
      });
    },
  );
});

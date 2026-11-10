import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SecretManager, type VaultProvider } from '@hacm/core';
import { createDatabase, createSqliteRepositories } from '../db/index.js';
import { JobEventBroker } from '../events/job-events.js';
import { HostRegistry } from '../hosts/registry.js';
import { DurableJobQueue } from '../jobs/queue.js';
import { PromptService } from '../prompts/service.js';
import { VaultService } from './service.js';
import {
  VaultProviderNotRequiredError,
  VaultUnlockFailedError,
} from './types.js';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function fixture(
  initialStatus:
    | 'locked'
    | 'locked_without_reason'
    | 'unlocked'
    | 'unavailable'
    | 'unavailable_without_reason' = 'locked',
) {
  const directory = await mkdtemp(join(tmpdir(), 'hacm-vault-service-'));
  await mkdir(join(directory, 'hosts', 'pve-01'), { recursive: true });
  await writeFile(
    join(directory, 'hosts', 'pve-01', 'host.yaml'),
    `schema_version: 1
id: pve-01
name: Fixture Host
type: proxmox
index: 1
connection:
  ssh:
    host: 192.0.2.10
    password: !cmd "fixture-vault read ssh-password"
`,
  );
  const database = createDatabase({ path: ':memory:' });
  const repos = createSqliteRepositories(database.db);
  const registry = new HostRegistry({ dataDir: directory, repos });
  await registry.sync();
  let state = initialStatus;
  let token: string | undefined;
  const provider: VaultProvider = {
    id: 'fixture',
    name: 'Fixture Vault',
    commands: ['fixture-vault'],
    tokenLabel: 'Fixture session token',
    helpText: 'Unlock the fixture vault.',
    async status() {
      return state === 'unavailable'
        ? { status: 'unavailable', reason: 'fixture CLI missing' }
        : state === 'unavailable_without_reason'
          ? { status: 'unavailable' }
          : state === 'unlocked'
            ? { status: 'unlocked' }
            : state === 'locked_without_reason'
              ? { status: 'locked' }
              : { status: 'locked', reason: 'fixture vault locked' };
    },
    async unlock(value) {
      token = value;
      state =
        value === 'valid-token'
          ? 'unlocked'
          : value === 'silent-invalid'
            ? 'locked_without_reason'
            : 'locked';
      return state === 'unlocked'
        ? { status: 'unlocked' }
        : state === 'locked_without_reason'
          ? { status: 'locked' }
          : { status: 'locked', reason: 'invalid fixture token' };
    },
    clear() {
      token = undefined;
      state = 'locked';
    },
    environment() {
      return token ? { FIXTURE_TOKEN: token } : {};
    },
  };
  const manager = new SecretManager({
    dataDir: directory,
    allowlist: ['fixture-vault'],
    vaultProviders: [provider],
  });
  const queue = new DurableJobQueue(repos);
  const broker = new JobEventBroker(queue);
  const promptService = new PromptService(repos, broker, (jobId) =>
    queue.resumeWaitingJob(jobId),
  );
  queue.setPromptHandler((job, request, signal) =>
    promptService.request({ ...request, jobId: job.id, signal }),
  );
  const service = new VaultService(manager, registry, repos);
  queue.setPreflightHandler((context) => service.preflight(context));
  cleanups.push(async () => {
    await queue.stop();
    broker.close();
    registry.close();
    database.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { repos, registry, manager, queue, broker, promptService, service };
}

describe('VaultService', () => {
  it('pauses a dependent job, unlocks through a memory-only token, and resumes it', async () => {
    const test = await fixture();
    const promptEvent = vi.fn();
    test.broker.on('prompt', promptEvent);
    const handler = vi.fn(async () => undefined);
    test.queue.registerHandler('vault-dependent', handler);
    await test.queue.start();
    const job = await test.queue.enqueue({
      id: 'vault-job',
      hostId: 'pve-01',
      type: 'vault-dependent',
    });
    await vi.waitFor(async () => {
      expect((await test.queue.get(job.id))?.status).toBe('waiting_input');
    });
    expect(handler).not.toHaveBeenCalled();
    const [prompt] = await test.promptService.listForJob(job.id);
    expect(prompt).toMatchObject({
      kind: 'confirm',
      payload: {
        type: 'vault_unlock',
        providerId: 'fixture',
        storage: 'memory_only',
      },
    });
    expect(promptEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'prompt.created',
        data: expect.objectContaining({
          payload: expect.objectContaining({ type: 'vault_unlock' }),
        }),
      }),
    );

    await expect(
      test.service.unlock('pve-01', 'fixture', 'valid-token', {
        id: 'admin-1',
        username: 'admin',
      }),
    ).resolves.toMatchObject({ status: 'unlocked' });
    await test.promptService.resolve(
      prompt!.id,
      { id: 'admin-1', username: 'admin' },
      { kind: 'confirm', confirmed: true },
    );
    await expect(test.queue.waitForJob(job.id)).resolves.toMatchObject({
      status: 'completed',
    });
    expect(handler).toHaveBeenCalledOnce();
    expect((await test.registry.getHost('pve-01'))?.runtime.vault).toEqual({
      status: 'unlocked',
    });

    const persisted = JSON.stringify({
      job: await test.repos.jobs.get(job.id),
      prompts: await test.repos.prompts.list({ jobId: job.id }),
      logs: await test.repos.jobLogLines.list(job.id, { afterSeq: 0 }),
      audit: await test.repos.auditLogs.search({ hostId: 'pve-01' }),
    });
    expect(persisted).not.toContain('valid-token');
    expect(persisted).toContain('memory_only');
  });

  it('fails gracefully when a required CLI is unavailable', async () => {
    const test = await fixture('unavailable');
    const handler = vi.fn(async () => undefined);
    test.queue.registerHandler('vault-dependent', handler);
    await test.queue.start();
    const job = await test.queue.enqueue({
      hostId: 'pve-01',
      type: 'vault-dependent',
    });
    await expect(test.queue.waitForJob(job.id)).resolves.toMatchObject({
      status: 'failed',
      error: 'fixture CLI missing',
    });
    expect(handler).not.toHaveBeenCalled();
    expect(await test.promptService.listForJob(job.id)).toEqual([]);
  });

  it('fails a job when an unlock prompt is declined', async () => {
    const test = await fixture();
    test.queue.registerHandler('vault-dependent', async () => undefined);
    await test.queue.start();
    const job = await test.queue.enqueue({
      hostId: 'pve-01',
      type: 'vault-dependent',
    });
    await vi.waitFor(async () => {
      expect((await test.queue.get(job.id))?.status).toBe('waiting_input');
    });
    const [prompt] = await test.promptService.listForJob(job.id);
    await test.promptService.resolve(
      prompt!.id,
      { id: 'admin-1', username: 'admin' },
      { kind: 'confirm', confirmed: false },
    );
    await expect(test.queue.waitForJob(job.id)).resolves.toMatchObject({
      status: 'failed',
      error: "Unlock was declined for vault provider 'fixture'",
    });
  });

  it('returns no providers for missing hosts and rejects unrelated providers', async () => {
    const test = await fixture('unlocked');
    await expect(test.service.listForHost('missing')).resolves.toEqual([]);
    await expect(
      test.service.unlock('pve-01', 'other', 'unused', {
        id: 'admin-1',
        username: 'admin',
      }),
    ).rejects.toBeInstanceOf(VaultProviderNotRequiredError);
  });

  it('rejects invalid tokens and a confirmation that did not actually unlock', async () => {
    const test = await fixture();
    await expect(
      test.service.unlock('pve-01', 'fixture', 'invalid-token', {
        id: 'admin-1',
        username: 'admin',
      }),
    ).rejects.toBeInstanceOf(VaultUnlockFailedError);
    await expect(
      test.service.unlock('pve-01', 'fixture', 'silent-invalid', {
        id: 'admin-1',
        username: 'admin',
      }),
    ).rejects.toThrow('Could not unlock Fixture Vault');
    expect((await test.registry.getHost('pve-01'))?.runtime.vault.status).toBe(
      'locked',
    );

    await expect(
      test.service.preflight({
        job: {
          id: 'direct-preflight',
          hostId: 'pve-01',
        } as never,
        payload: undefined,
        signal: new AbortController().signal,
        log: async () => undefined,
        prompt: async () => ({ kind: 'confirm', confirmed: true }),
      }),
    ).rejects.toBeInstanceOf(VaultUnlockFailedError);
  });

  it('uses safe fallback messages and skips prompts for unlocked providers', async () => {
    const unavailable = await fixture('unavailable_without_reason');
    unavailable.queue.registerHandler('vault-dependent', async () => undefined);
    await unavailable.queue.start();
    const failed = await unavailable.queue.enqueue({
      hostId: 'pve-01',
      type: 'vault-dependent',
    });
    await expect(
      unavailable.queue.waitForJob(failed.id),
    ).resolves.toMatchObject({
      status: 'failed',
      error: 'Fixture Vault is unavailable',
    });

    const unlocked = await fixture('unlocked');
    const prompt = vi.fn(async () => ({ kind: 'confirm', confirmed: true }));
    await expect(
      unlocked.service.preflight({
        job: { id: 'unlocked-job', hostId: 'pve-01' } as never,
        payload: undefined,
        signal: new AbortController().signal,
        log: async () => undefined,
        prompt,
      }),
    ).resolves.toBeUndefined();
    expect(prompt).not.toHaveBeenCalled();

    const locked = await fixture('locked_without_reason');
    await expect(
      locked.service.preflight({
        job: { id: 'locked-job', hostId: 'pve-01' } as never,
        payload: undefined,
        signal: new AbortController().signal,
        log: async () => undefined,
        prompt: async () => ({ kind: 'confirm', confirmed: true }),
      }),
    ).rejects.toThrow('Fixture Vault is still locked');
  });

  it('does not prompt jobs for hosts without a configured provider', async () => {
    const test = await fixture('unlocked');
    const prompt = vi.fn(async () => ({ kind: 'confirm', confirmed: true }));
    await expect(
      test.service.preflight({
        job: { id: 'missing-host', hostId: 'missing' } as never,
        payload: undefined,
        signal: new AbortController().signal,
        log: async () => undefined,
        prompt,
      }),
    ).resolves.toBeUndefined();
    expect(prompt).not.toHaveBeenCalled();
  });
});

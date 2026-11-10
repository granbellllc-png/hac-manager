import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { globalSecretRedactor } from '@hacm/core';
import { createDatabase, createSqliteRepositories } from '../db/index.js';
import type { ConsoleSocket } from './types.js';
import { ConsoleService, consoleServiceInternals } from './service.js';

class FakeSocket implements ConsoleSocket {
  public readonly sent: string[] = [];
  public readonly closes: Array<{ code?: number; reason?: string }> = [];
  private readonly messageListeners: Array<(data: string) => void> = [];
  private readonly closeListeners: Array<() => void> = [];
  private readonly errorListeners: Array<(error: Error) => void> = [];
  public throwOnSend = false;

  public send(data: string): void {
    if (this.throwOnSend) throw new Error('socket already closed');
    this.sent.push(data);
  }

  public close(code?: number, reason?: string): void {
    this.closes.push({
      ...(code !== undefined ? { code } : {}),
      ...(reason !== undefined ? { reason } : {}),
    });
    for (const listener of this.closeListeners) listener();
  }

  public onMessage(listener: (data: string) => void): void {
    this.messageListeners.push(listener);
  }

  public onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  public onError(listener: (error: Error) => void): void {
    this.errorListeners.push(listener);
  }

  public message(value: unknown): void {
    const data = typeof value === 'string' ? value : JSON.stringify(value);
    for (const listener of this.messageListeners) listener(data);
  }

  public error(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
  }
}

function fixture() {
  const database = createDatabase({ path: ':memory:' });
  const repos = createSqliteRepositories(database.db);
  const shell = Object.assign(new EventEmitter(), {
    write: vi.fn(),
    resize: vi.fn(),
    close: vi.fn(),
  });
  const router = { openConsole: vi.fn(async () => shell) };
  const connections = { getRouter: vi.fn(async () => router) };
  return { database, repos, shell, router, connections };
}

const context = {
  user: {
    id: 'operator-1',
    username: 'operator',
    role: 'operator',
    autoGrantNewHosts: false,
  },
  request: {
    hostId: 'pve-01',
    target: 'lxc' as const,
    vmid: 112,
    cols: 100,
    rows: 30,
    recording: true,
  },
};

afterEach(() => {
  vi.useRealTimers();
  globalSecretRedactor.clear();
});

describe('ConsoleService', () => {
  it('bridges terminal messages without persisting the transcript and audits start/stop', async () => {
    const test = fixture();
    const times = [
      new Date('2026-11-10T10:00:00Z'),
      new Date('2026-11-10T10:00:05Z'),
    ];
    const service = new ConsoleService(test.connections as never, test.repos, {
      idleTimeoutMs: 60_000,
      now: () => times.shift() ?? new Date('2026-11-10T10:00:05Z'),
    });
    const socket = new FakeSocket();
    await service.open(socket, context);
    expect(test.router.openConsole).toHaveBeenCalledWith(
      expect.objectContaining({
        target: 'lxc',
        vmid: 112,
        cols: 100,
        rows: 30,
      }),
    );
    expect(socket.sent.map((value) => JSON.parse(value))).toContainEqual(
      expect.objectContaining({ type: 'ready', target: 'lxc' }),
    );

    socket.message({ type: 'input', data: 'sensitive terminal input\n' });
    socket.message({ type: 'resize', cols: 120, rows: 40 });
    socket.message({ type: 'ping' });
    socket.message('{bad json');
    test.shell.emit('data', Buffer.from('sensitive terminal output\n'));
    expect(test.shell.write).toHaveBeenCalledWith('sensitive terminal input\n');
    expect(test.shell.resize).toHaveBeenCalledWith(120, 40);
    expect(socket.sent.map((value) => JSON.parse(value))).toEqual(
      expect.arrayContaining([
        { type: 'pong' },
        { type: 'error', message: 'Invalid console message' },
        { type: 'output', data: 'sensitive terminal output\n' },
      ]),
    );

    socket.close(1000, 'done');
    await vi.waitFor(async () => {
      expect(
        (await test.repos.auditLogs.search({ hostId: 'pve-01' })).total,
      ).toBe(2);
    });
    const audit = JSON.stringify(
      await test.repos.auditLogs.search({ hostId: 'pve-01' }),
    );
    expect(audit).toContain('browser_memory_only');
    expect(audit).not.toContain('sensitive terminal input');
    expect(audit).not.toContain('sensitive terminal output');
    expect(audit).toContain('5000');
    test.database.close();
  });

  it('closes idle sessions and handles shell exit and socket errors once', async () => {
    vi.useFakeTimers();
    const test = fixture();
    const service = new ConsoleService(test.connections as never, test.repos, {
      idleTimeoutMs: 100,
    });
    const socket = new FakeSocket();
    await service.open(socket, context);
    await vi.advanceTimersByTimeAsync(101);
    expect(socket.closes).toContainEqual({
      code: 1000,
      reason: 'Console idle timeout',
    });
    expect(socket.sent.map((value) => JSON.parse(value))).toContainEqual({
      type: 'idle_timeout',
    });
    test.shell.emit('exit', { code: 0 });
    socket.error(new Error('late socket error'));
    await vi.runAllTimersAsync();
    expect(
      (await test.repos.auditLogs.search({ action: 'console.stop' })).total,
    ).toBe(1);
    test.database.close();
  });

  it('handles shell exit and shell errors before the idle timeout', async () => {
    const exited = fixture();
    const exitService = new ConsoleService(
      exited.connections as never,
      exited.repos,
    );
    const exitSocket = new FakeSocket();
    await exitService.open(exitSocket, {
      ...context,
      request: { ...context.request, target: 'host', vmid: undefined },
    });
    exited.shell.emit('exit', { code: 0, signal: undefined });
    await vi.waitFor(async () => {
      expect(
        (await exited.repos.auditLogs.search({ action: 'console.stop' })).total,
      ).toBe(1);
    });
    expect(exitSocket.sent.map((value) => JSON.parse(value))).toContainEqual({
      type: 'exit',
      code: 0,
    });
    exited.database.close();

    const errored = fixture();
    const errorService = new ConsoleService(
      errored.connections as never,
      errored.repos,
    );
    const errorSocket = new FakeSocket();
    await errorService.open(errorSocket, context);
    errored.shell.emit('error', new Error('shell failed'));
    await vi.waitFor(async () => {
      expect(
        (await errored.repos.auditLogs.search({ action: 'console.stop' }))
          .total,
      ).toBe(1);
    });
    expect(errorSocket.sent.map((value) => JSON.parse(value))).toContainEqual({
      type: 'error',
      message: 'shell failed',
    });
    errored.database.close();
  });

  it('closes a shell that opens after the client disconnects and reports audit failures', async () => {
    const test = fixture();
    let resolveRouter!: (router: typeof test.router) => void;
    test.connections.getRouter.mockImplementationOnce(
      () => new Promise((resolve) => (resolveRouter = resolve)),
    );
    const onError = vi.fn();
    const service = new ConsoleService(test.connections as never, test.repos, {
      onError,
    });
    const socket = new FakeSocket();
    const opening = service.open(socket, context);
    await vi.waitFor(() =>
      expect(test.connections.getRouter).toHaveBeenCalled(),
    );
    socket.close();
    resolveRouter(test.router);
    await opening;
    expect(test.shell.close).toHaveBeenCalled();

    const originalAppend = test.repos.auditLogs.append.bind(
      test.repos.auditLogs,
    );
    vi.spyOn(test.repos.auditLogs, 'append').mockImplementation((input) =>
      input.action === 'console.stop'
        ? Promise.reject(new Error('audit unavailable'))
        : originalAppend(input),
    );
    const secondSocket = new FakeSocket();
    await service.open(secondSocket, context);
    secondSocket.close();
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith(expect.any(Error)),
    );
    test.database.close();
  });

  it('ignores writes after the WebSocket closes between events', async () => {
    const test = fixture();
    const service = new ConsoleService(test.connections as never, test.repos);
    const socket = new FakeSocket();
    await service.open(socket, context);
    socket.throwOnSend = true;
    test.shell.emit('data', Buffer.from('late output'));
    socket.message({ type: 'ping' });
    socket.close();
    await vi.waitFor(async () => {
      expect(
        (await test.repos.auditLogs.search({ action: 'console.stop' })).total,
      ).toBe(1);
    });
    test.database.close();
  });

  it('redacts connection failures in the client response and audit metadata', async () => {
    const test = fixture();
    globalSecretRedactor.register('fixture-console-secret');
    test.connections.getRouter.mockRejectedValueOnce(
      new Error('failed with fixture-console-secret'),
    );
    const service = new ConsoleService(test.connections as never, test.repos);
    const socket = new FakeSocket();
    await service.open(socket, context);
    expect(socket.closes).toContainEqual({
      code: 1011,
      reason: 'Console unavailable',
    });
    const serialized = JSON.stringify({
      sent: socket.sent,
      audit: await test.repos.auditLogs.search({ hostId: 'pve-01' }),
    });
    expect(serialized).toContain('***');
    expect(serialized).not.toContain('fixture-console-secret');
    test.database.close();
  });

  it('validates bounded client messages', () => {
    expect(consoleServiceInternals.boundedInteger(20, 20, 500)).toBe(20);
    expect(consoleServiceInternals.boundedInteger(19, 20, 500)).toBeUndefined();
    expect(
      consoleServiceInternals.boundedInteger(20.5, 20, 500),
    ).toBeUndefined();
    expect(consoleServiceInternals.parseClientMessage('{')).toBeUndefined();
    expect(
      consoleServiceInternals.parseClientMessage(
        JSON.stringify({ type: 'input', data: 'ok' }),
      ),
    ).toEqual({ type: 'input', data: 'ok' });
    expect(
      consoleServiceInternals.parseClientMessage(
        JSON.stringify({ type: 'resize', cols: 80, rows: 24 }),
      ),
    ).toEqual({ type: 'resize', cols: 80, rows: 24 });
    expect(
      consoleServiceInternals.parseClientMessage(
        JSON.stringify({ type: 'ping' }),
      ),
    ).toEqual({ type: 'ping' });
    expect(
      consoleServiceInternals.parseClientMessage(
        JSON.stringify({ type: 'unknown' }),
      ),
    ).toBeUndefined();
    expect(
      consoleServiceInternals.parseClientMessage(
        JSON.stringify({ type: 'resize', cols: 10, rows: 2 }),
      ),
    ).toBeUndefined();
    expect(
      consoleServiceInternals.parseClientMessage(
        JSON.stringify({ type: 'input', data: 'x'.repeat(70_000) }),
      ),
    ).toBeUndefined();
    expect(
      consoleServiceInternals.parseClientMessage('x'.repeat(70_000)),
    ).toBeUndefined();
  });
});

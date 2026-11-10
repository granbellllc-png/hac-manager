import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, type AuthUser } from '../auth/auth-context';

const terminalMock = vi.hoisted(() => {
  const instances: Array<{
    cols: number;
    rows: number;
    write: ReturnType<typeof vi.fn>;
    writeln: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    input(data: string): void;
  }> = [];
  class FakeTerminal {
    public cols = 80;
    public rows = 24;
    public readonly write = vi.fn();
    public readonly writeln = vi.fn();
    public readonly clear = vi.fn();
    public readonly dispose = vi.fn();
    private dataListener?: ((data: string) => void) | undefined;

    public constructor() {
      instances.push(this);
    }

    public loadAddon() {}
    public open() {}
    public onData(listener: (data: string) => void) {
      this.dataListener = listener;
      return { dispose: vi.fn() };
    }
    public input(data: string) {
      this.dataListener?.(data);
    }
  }
  return { instances, FakeTerminal };
});

vi.mock('@xterm/xterm', () => ({ Terminal: terminalMock.FakeTerminal }));
const fitMock = vi.hoisted(() => {
  const instances: Array<{ fit: ReturnType<typeof vi.fn> }> = [];
  class FakeFitAddon {
    public readonly fit = vi.fn();
    public constructor() {
      instances.push(this);
    }
  }
  return { instances, FakeFitAddon };
});
vi.mock('@xterm/addon-fit', () => ({ FitAddon: fitMock.FakeFitAddon }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

class FakeResizeObserver {
  public static instances: FakeResizeObserver[] = [];
  public readonly disconnect = vi.fn();
  public constructor(private readonly callback: () => void) {
    FakeResizeObserver.instances.push(this);
  }
  public observe() {}
  public trigger() {
    this.callback();
  }
}

class FakeWebSocket {
  public static readonly CONNECTING = 0;
  public static readonly OPEN = 1;
  public static readonly CLOSED = 3;
  public static instances: FakeWebSocket[] = [];
  public readyState = FakeWebSocket.CONNECTING;
  public readonly sent: string[] = [];
  public onmessage: ((event: MessageEvent<string>) => void) | null = null;
  public onerror: (() => void) | null = null;
  public onclose: (() => void) | null = null;

  public constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  public send(data: string) {
    this.sent.push(data);
  }

  public close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  public open() {
    this.readyState = FakeWebSocket.OPEN;
  }

  public message(value: unknown) {
    this.onmessage?.(
      new MessageEvent('message', { data: JSON.stringify(value) }),
    );
  }
}

function installApi(fail = false) {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>().mockResolvedValue(
      fail
        ? Response.json({}, { status: 500 })
        : Response.json({
            hosts: [
              {
                id: 'pve-01',
                name: 'Fixture Host',
                type: 'proxmox',
                index: 1,
                status: 'healthy',
                runtime: {},
                updatedAt: '2026-11-10T10:00:00.000Z',
              },
            ],
          }),
    ),
  );
}

function renderPage(user?: AuthUser) {
  return render(
    <AuthProvider
      initialUser={user ?? { id: 'admin-1', username: 'admin', role: 'admin' }}
      initialSetupNeeded={false}
    >
      <ConsolePage />
    </AuthProvider>,
  );
}

beforeEach(() => {
  terminalMock.instances.length = 0;
  fitMock.instances.length = 0;
  FakeResizeObserver.instances.length = 0;
  FakeWebSocket.instances.length = 0;
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('WebSocket', FakeWebSocket);
  installApi();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

import { ConsolePage, consolePageInternals } from './console';

describe('ConsolePage', () => {
  it('connects, forwards terminal input, records output locally, and disconnects', async () => {
    const user = userEvent.setup();
    renderPage();
    expect(
      await screen.findByRole('option', { name: 'Fixture Host' }),
    ).toBeVisible();
    await user.click(
      screen.getByLabelText(
        'Record output locally in this browser (never stored by the server)',
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    const socket = FakeWebSocket.instances[0]!;
    expect(socket.url).toContain('hostId=pve-01');
    expect(socket.url).toContain('recording=true');
    socket.open();
    socket.message({ type: 'ready' });
    expect(await screen.findByText('connected')).toBeVisible();
    terminalMock.instances[0]!.input('ls\r');
    expect(socket.sent).toContain(
      JSON.stringify({ type: 'input', data: 'ls\r' }),
    );
    FakeResizeObserver.instances[0]!.trigger();
    expect(socket.sent).toContain(
      JSON.stringify({ type: 'resize', cols: 80, rows: 24 }),
    );
    socket.message({ type: 'output', data: 'fixture output\r\n' });
    expect(terminalMock.instances[0]!.write).toHaveBeenCalledWith(
      'fixture output\r\n',
    );
    expect(
      await screen.findByRole('button', { name: 'Download' }),
    ).toBeVisible();
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:fixture'),
      revokeObjectURL: vi.fn(),
    });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    await user.click(screen.getByRole('button', { name: 'Download' }));
    expect(click).toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByText('disconnected')).toBeVisible();
  });

  it('validates LXC VMIDs and displays protocol and connection errors', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('option', { name: 'Fixture Host' });
    await user.selectOptions(screen.getByLabelText('Target'), 'lxc');
    await user.type(screen.getByLabelText('VMID'), '99');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText(/valid LXC VMID/)).toBeVisible();
    await user.clear(screen.getByLabelText('VMID'));
    await user.type(screen.getByLabelText('VMID'), '112');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.message({ type: 'ready' });
    socket.message({ type: 'idle_timeout' });
    socket.message({ type: 'exit' });
    socket.message({ type: 'error' });
    expect(await screen.findByText('Console error')).toBeVisible();
    socket.message('invalid');
    expect(
      await screen.findByText('Received an invalid console message.'),
    ).toBeVisible();
    socket.onerror?.();
    expect(await screen.findByText('Console connection failed.')).toBeVisible();
  });

  it('denies viewers in the UI', async () => {
    renderPage({ id: 'viewer-1', username: 'viewer', role: 'viewer' });
    expect(
      await screen.findByText(/Viewer accounts cannot open/),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
  });

  it('reports host loading failures and ignores terminal input while disconnected', async () => {
    installApi(true);
    renderPage();
    expect(
      await screen.findByText('Could not load console hosts.'),
    ).toBeVisible();
    terminalMock.instances[0]!.input('ignored');
    FakeResizeObserver.instances[0]!.trigger();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('builds safe WebSocket URLs and transcript filenames', () => {
    expect(
      consolePageInternals.websocketUrl(
        {
          hostId: 'pve 01',
          target: 'lxc',
          vmid: 112,
          cols: 80,
          rows: 24,
          recording: false,
        },
        'https://example.test/app',
      ),
    ).toContain('vmid=112');
    expect(
      consolePageInternals.websocketUrl(
        {
          hostId: 'pve-01',
          target: 'host',
          cols: 80,
          rows: 24,
          recording: false,
        },
        'http://example.test/app',
      ),
    ).toBe(
      'ws://example.test/api/console?hostId=pve-01&target=host&cols=80&rows=24&recording=false',
    );
    expect(consolePageInternals.safeFilePart('pve 01/unsafe')).toBe(
      'pve-01-unsafe',
    );
    expect(consolePageInternals.validLxcVmid('112')).toBe(112);
    expect(consolePageInternals.validLxcVmid('99')).toBeUndefined();
    expect(consolePageInternals.validLxcVmid('nope')).toBeUndefined();
    expect(
      consolePageInternals.parseConsoleServerMessage(
        JSON.stringify({ type: 'output', data: 'ok' }),
      ),
    ).toEqual({ type: 'output', data: 'ok' });
    for (const type of ['ready', 'idle_timeout', 'exit'] as const) {
      expect(
        consolePageInternals.parseConsoleServerMessage(
          JSON.stringify({ type }),
        ),
      ).toEqual({ type });
    }
    expect(
      consolePageInternals.parseConsoleServerMessage(
        JSON.stringify({ type: 'error', message: 'failed' }),
      ),
    ).toEqual({ type: 'error', message: 'failed' });
    expect(
      consolePageInternals.parseConsoleServerMessage(
        JSON.stringify({ type: 'error' }),
      ),
    ).toEqual({ type: 'error', message: 'Console error' });
    expect(consolePageInternals.parseConsoleServerMessage('{')).toBeUndefined();
    expect(
      consolePageInternals.parseConsoleServerMessage(JSON.stringify('bad')),
    ).toBeUndefined();
    expect(
      consolePageInternals.parseConsoleServerMessage(
        JSON.stringify({ type: 'unknown' }),
      ),
    ).toBeUndefined();
    expect(consolePageInternals.appendBoundedTranscript('a', 'b', false)).toBe(
      'a',
    );
    expect(consolePageInternals.appendBoundedTranscript('a', 'b', true)).toBe(
      'ab',
    );
    expect(
      consolePageInternals
        .appendBoundedTranscript('x'.repeat(5 * 1024 * 1024), 'tail', true)
        .endsWith('tail'),
    ).toBe(true);
  });
});

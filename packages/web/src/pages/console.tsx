import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Plug, Square } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { apiClient } from '../api/client';
import { useAuth } from '../auth/auth-context';
import { Button } from '../components/ui/button';
import { cn } from '../lib/utils';

interface HostOption {
  readonly id: string;
  readonly name: string;
}

type ConsoleStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

const MAX_LOCAL_TRANSCRIPT_BYTES = 5 * 1024 * 1024;

type ConsoleServerMessage =
  | { readonly type: 'output'; readonly data: string }
  | { readonly type: 'ready' }
  | { readonly type: 'idle_timeout' }
  | { readonly type: 'exit' }
  | { readonly type: 'error'; readonly message: string };

function parseConsoleServerMessage(
  raw: unknown,
): ConsoleServerMessage | undefined {
  try {
    const parsed = JSON.parse(String(raw)) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const value = parsed as Record<string, unknown>;
    if (value['type'] === 'output' && typeof value['data'] === 'string') {
      return { type: 'output', data: value['data'] };
    }
    if (
      value['type'] === 'ready' ||
      value['type'] === 'idle_timeout' ||
      value['type'] === 'exit'
    ) {
      return { type: value['type'] };
    }
    if (value['type'] === 'error') {
      return {
        type: 'error',
        message:
          typeof value['message'] === 'string'
            ? value['message']
            : 'Console error',
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function appendBoundedTranscript(
  current: string,
  data: string,
  enabled: boolean,
): string {
  if (!enabled) return current;
  const next = current + data;
  return new Blob([next]).size > MAX_LOCAL_TRANSCRIPT_BYTES
    ? next.slice(-MAX_LOCAL_TRANSCRIPT_BYTES)
    : next;
}

function validLxcVmid(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 100 ? parsed : undefined;
}

function websocketUrl(
  input: {
    readonly hostId: string;
    readonly target: 'host' | 'lxc';
    readonly vmid?: number | undefined;
    readonly cols: number;
    readonly rows: number;
    readonly recording: boolean;
  },
  baseUrl = window.location.href,
): string {
  const url = new URL('/api/console', baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('hostId', input.hostId);
  url.searchParams.set('target', input.target);
  if (input.vmid !== undefined)
    url.searchParams.set('vmid', String(input.vmid));
  url.searchParams.set('cols', String(input.cols));
  url.searchParams.set('rows', String(input.rows));
  url.searchParams.set('recording', String(input.recording));
  return url.toString();
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, '-');
}

export function ConsolePage() {
  const { user } = useAuth();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const recordingRef = useRef(false);
  const transcriptRef = useRef('');
  const [hosts, setHosts] = useState<HostOption[]>([]);
  const [hostId, setHostId] = useState('');
  const [target, setTarget] = useState<'host' | 'lxc'>('host');
  const [vmid, setVmid] = useState('');
  const [recording, setRecording] = useState(false);
  const [hasTranscript, setHasTranscript] = useState(false);
  const [status, setStatus] = useState<ConsoleStatus>('disconnected');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void apiClient.GET('/api/hosts').then(({ data, error: apiError }) => {
      if (cancelled) return;
      if (apiError || !data) {
        setError('Could not load console hosts.');
        return;
      }
      const options = data.hosts.map((host) => ({
        id: host.id,
        name: host.name,
      }));
      setHosts(options);
      setHostId((current) => current || options[0]?.id || '');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 14,
      scrollback: 5000,
      theme: {
        background: '#09090b',
        foreground: '#fafafa',
        cursor: '#f59e0b',
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(containerRef.current);
    fit.fit();
    terminal.writeln('\x1b[33mHAC Manager interactive console\x1b[0m');
    const dataDisposable = terminal.onData((data) => {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'input', data }));
      }
    });
    const resizeObserver = new ResizeObserver(() => {
      fit.fit();
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            type: 'resize',
            cols: terminal.cols,
            rows: terminal.rows,
          }),
        );
      }
    });
    resizeObserver.observe(containerRef.current);
    terminalRef.current = terminal;
    fitRef.current = fit;
    return () => {
      socketRef.current?.close(1000, 'Page closed');
      socketRef.current = null;
      resizeObserver.disconnect();
      dataDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, []);

  const appendTranscript = useCallback((data: string) => {
    transcriptRef.current = appendBoundedTranscript(
      transcriptRef.current,
      data,
      recordingRef.current,
    );
    setHasTranscript(transcriptRef.current.length > 0);
  }, []);

  const disconnect = useCallback(() => {
    socketRef.current?.close(1000, 'Closed by user');
    socketRef.current = null;
    setStatus('disconnected');
  }, []);

  const connect = useCallback(() => {
    if (!hostId || user?.role === 'viewer') return;
    const parsedVmid = target === 'lxc' ? validLxcVmid(vmid) : undefined;
    if (target === 'lxc' && parsedVmid === undefined) {
      setError('Enter a valid LXC VMID (100 or greater).');
      return;
    }
    disconnect();
    fitRef.current?.fit();
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.clear();
    terminal.writeln('\x1b[33mConnecting…\x1b[0m');
    setError(null);
    setStatus('connecting');
    recordingRef.current = recording;
    transcriptRef.current = '';
    setHasTranscript(false);
    const socket = new WebSocket(
      websocketUrl({
        hostId,
        target,
        ...(parsedVmid !== undefined ? { vmid: parsedVmid } : {}),
        cols: terminal.cols,
        rows: terminal.rows,
        recording,
      }),
    );
    socketRef.current = socket;
    socket.onmessage = (event) => {
      const message = parseConsoleServerMessage(event.data);
      if (!message) {
        setError('Received an invalid console message.');
        setStatus('error');
      } else if (message.type === 'output') {
        terminal.write(message.data);
        appendTranscript(message.data);
      } else if (message.type === 'ready') {
        terminal.clear();
        setStatus('connected');
      } else if (message.type === 'idle_timeout') {
        terminal.writeln('\r\n\x1b[33mConsole closed after being idle.\x1b[0m');
      } else if (message.type === 'exit') {
        terminal.writeln('\r\n\x1b[33mRemote shell exited.\x1b[0m');
      } else {
        terminal.writeln(`\r\n\x1b[31m${message.message}\x1b[0m`);
        setError(message.message);
        setStatus('error');
      }
    };
    socket.onerror = () => {
      setError('Console connection failed.');
      setStatus('error');
    };
    socket.onclose = () => {
      socketRef.current = null;
      setStatus((current) => (current === 'error' ? 'error' : 'disconnected'));
    };
  }, [
    appendTranscript,
    disconnect,
    hostId,
    recording,
    target,
    user?.role,
    vmid,
  ]);

  const downloadTranscript = () => {
    if (!transcriptRef.current) return;
    const blob = new Blob([transcriptRef.current], {
      type: 'text/plain;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${safeFilePart(hostId)}-${target}${vmid ? `-${safeFilePart(vmid)}` : ''}-console.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const viewer = user?.role === 'viewer';
  return (
    <section className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold">Console</h1>
        <p className="text-sm text-muted-foreground">
          Interactive SSH terminals for hosts and LXC guests. Sessions are
          audited and close automatically when idle.
        </p>
      </header>

      {viewer && (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
          Viewer accounts cannot open interactive consoles.
        </p>
      )}
      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}

      <div className="grid gap-3 rounded-xl border border-border p-4 md:grid-cols-[1fr_10rem_10rem_auto] md:items-end">
        <div className="space-y-1 text-sm font-medium">
          <label htmlFor="console-host">Host</label>
          <select
            id="console-host"
            value={hostId}
            disabled={status === 'connected' || status === 'connecting'}
            onChange={(event) => setHostId(event.target.value)}
            className="h-10 w-full rounded-md border border-border bg-background px-3"
          >
            {hosts.map((host) => (
              <option key={host.id} value={host.id}>
                {host.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1 text-sm font-medium">
          <label htmlFor="console-target">Target</label>
          <select
            id="console-target"
            value={target}
            disabled={status === 'connected' || status === 'connecting'}
            onChange={(event) =>
              setTarget(event.target.value as 'host' | 'lxc')
            }
            className="h-10 w-full rounded-md border border-border bg-background px-3"
          >
            <option value="host">Host shell</option>
            <option value="lxc">LXC guest</option>
          </select>
        </div>
        {target === 'lxc' ? (
          <div className="space-y-1 text-sm font-medium">
            <label htmlFor="console-vmid">VMID</label>
            <input
              id="console-vmid"
              value={vmid}
              inputMode="numeric"
              disabled={status === 'connected' || status === 'connecting'}
              onChange={(event) => setVmid(event.target.value)}
              className="h-10 w-full rounded-md border border-border bg-background px-3"
              placeholder="112"
            />
          </div>
        ) : (
          <div />
        )}
        <div className="flex flex-wrap gap-2">
          {status === 'connected' || status === 'connecting' ? (
            <Button type="button" variant="outline" onClick={disconnect}>
              <Square aria-hidden className="h-4 w-4" />
              Disconnect
            </Button>
          ) : (
            <Button
              type="button"
              disabled={viewer || !hostId}
              onClick={connect}
            >
              <Plug aria-hidden className="h-4 w-4" />
              Connect
            </Button>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm md:col-span-3">
          <input
            type="checkbox"
            checked={recording}
            disabled={status === 'connected' || status === 'connecting'}
            onChange={(event) => setRecording(event.target.checked)}
          />
          Record output locally in this browser (never stored by the server)
        </label>
        <div className="flex items-center justify-between gap-2 md:col-span-1 md:justify-end">
          <span
            className={cn(
              'rounded-full px-2 py-1 text-xs font-medium',
              status === 'connected'
                ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                : status === 'error'
                  ? 'bg-red-500/15 text-red-700 dark:text-red-300'
                  : 'bg-muted text-muted-foreground',
            )}
          >
            {status}
          </span>
          {hasTranscript && (
            <Button
              type="button"
              variant="outline"
              onClick={downloadTranscript}
            >
              <Download aria-hidden className="h-4 w-4" />
              Download
            </Button>
          )}
        </div>
      </div>

      <div
        ref={containerRef}
        role="application"
        aria-label="Interactive console terminal"
        className="h-[62vh] min-h-80 overflow-hidden rounded-xl border border-border bg-zinc-950 p-2 shadow-inner"
      />
    </section>
  );
}

export const consolePageInternals = {
  websocketUrl,
  safeFilePart,
  parseConsoleServerMessage,
  appendBoundedTranscript,
  validLxcVmid,
};

import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resetJobEventCursor,
  useJobEvents,
  type JobEventCallbacks,
} from './use-job-events';

class MockEventSource {
  public static readonly CONNECTING = 0;
  public static readonly OPEN = 1;
  public static readonly CLOSED = 2;
  public static instances: MockEventSource[] = [];
  public readonly listeners = new Map<string, Set<(event: Event) => void>>();
  public readyState = MockEventSource.CONNECTING;
  public closed = false;

  public constructor(
    public readonly url: string,
    public readonly options?: EventSourceInit,
  ) {
    MockEventSource.instances.push(this);
  }

  public addEventListener(type: string, listener: (event: Event) => void) {
    let listeners = this.listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener);
  }

  public close() {
    this.closed = true;
    this.readyState = MockEventSource.CLOSED;
  }

  public emit(type: string, data?: unknown) {
    if (type === 'open') this.readyState = MockEventSource.OPEN;
    const event =
      data === undefined
        ? new Event(type)
        : new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  public emitRaw(type: string, data: string) {
    const event = new MessageEvent(type, { data });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function Probe({
  jobId,
  callbacks,
  enabled = true,
}: {
  readonly jobId: string | null;
  readonly callbacks: JobEventCallbacks;
  readonly enabled?: boolean;
}) {
  const state = useJobEvents(jobId, callbacks, enabled);
  return <div>{`${state.connected}:${state.error ?? 'ok'}`}</div>;
}

beforeEach(() => {
  MockEventSource.instances = [];
  window.localStorage.clear();
  vi.stubGlobal('EventSource', MockEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useJobEvents', () => {
  it('resumes from local storage, deduplicates logs, and dispatches typed events', () => {
    window.localStorage.setItem('hacm-job-event:job/a', '4');
    const onLog = vi.fn();
    const onJob = vi.fn();
    const onPrompt = vi.fn();
    const callbacks = { onLog, onJob, onPrompt };
    const view = render(<Probe jobId="job/a" callbacks={callbacks} />);
    const source = MockEventSource.instances[0]!;
    expect(source.url).toBe('/api/jobs/job%2Fa/events?after=4');
    expect(source.options).toEqual({ withCredentials: true });

    act(() => {
      source.emit('open');
      source.emit('log', {
        jobId: 'job/a',
        seq: 5,
        ts: '2026-01-01T00:00:00.000Z',
        stream: 'stdout',
        text: 'hello',
      });
      source.emit('log', {
        jobId: 'job/a',
        seq: 5,
        ts: '2026-01-01T00:00:00.000Z',
        stream: 'stdout',
        text: 'duplicate',
      });
      source.emit('job', { id: 'job/a', status: 'running' });
      source.emit('prompt', { id: 'prompt' });
    });
    expect(screen.getByText('true:ok')).toBeInTheDocument();
    expect(onLog).toHaveBeenCalledTimes(1);
    expect(onJob).toHaveBeenCalledWith({ id: 'job/a', status: 'running' });
    expect(onPrompt).toHaveBeenCalledWith({ id: 'prompt' });
    expect(window.localStorage.getItem('hacm-job-event:job/a')).toBe('5');

    act(() => source.emit('error'));
    expect(screen.getByText(/false:Event stream disconnected/)).toBeVisible();
    view.unmount();
    expect(source.closed).toBe(true);
  });

  it('reports malformed events, handles disabled state, and resets cursors', () => {
    const callbacks = {
      onLog: vi.fn(),
      onJob: vi.fn(),
      onPrompt: vi.fn(),
    };
    const view = render(<Probe jobId="job" callbacks={callbacks} />);
    const source = MockEventSource.instances[0]!;
    act(() => {
      source.readyState = MockEventSource.OPEN;
      source.emitRaw('log', '{bad json');
      source.emitRaw('job', '{bad json');
      source.emitRaw('prompt', '{bad json');
    });
    expect(screen.getByText(/true:.*JSON/)).toBeVisible();
    expect(callbacks.onJob).not.toHaveBeenCalled();
    expect(callbacks.onPrompt).not.toHaveBeenCalled();

    view.rerender(<Probe jobId="job" callbacks={callbacks} enabled={false} />);
    expect(screen.getByText('false:ok')).toBeVisible();
    expect(source.closed).toBe(true);

    window.localStorage.setItem('hacm-job-event:job', '10');
    resetJobEventCursor('job');
    expect(window.localStorage.getItem('hacm-job-event:job')).toBeNull();
  });

  it('uses the latest callback without reconnecting', async () => {
    const first = vi.fn();
    const second = vi.fn();
    function StatefulProbe() {
      const [latest, setLatest] = useState(false);
      useJobEvents('job', { onJob: latest ? second : first });
      return (
        <button type="button" onClick={() => setLatest(true)}>
          update
        </button>
      );
    }
    render(<StatefulProbe />);
    const source = MockEventSource.instances[0]!;
    await userEvent.setup().click(screen.getByRole('button'));
    act(() => source.emit('job', { id: 'job' }));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith({ id: 'job' });
    expect(MockEventSource.instances).toHaveLength(1);
  });
});

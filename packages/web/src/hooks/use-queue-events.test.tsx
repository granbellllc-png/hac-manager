import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useQueueEvents, type QueueEventCallbacks } from './use-queue-events';

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
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  public close() {
    this.closed = true;
  }

  public emit(type: string, data?: string) {
    if (type === 'open') this.readyState = MockEventSource.OPEN;
    const event =
      data === undefined ? new Event(type) : new MessageEvent(type, { data });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function Probe({
  callbacks,
  enabled = true,
}: {
  readonly callbacks: QueueEventCallbacks;
  readonly enabled?: boolean;
}) {
  const state = useQueueEvents(callbacks, enabled);
  return <div>{`${state.connected}:${state.error ?? 'ok'}`}</div>;
}

beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal('EventSource', MockEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useQueueEvents', () => {
  it('streams jobs and prompts and reports connection state', () => {
    const onJob = vi.fn();
    const onPrompt = vi.fn();
    const view = render(<Probe callbacks={{ onJob, onPrompt }} />);
    const source = MockEventSource.instances[0]!;
    expect(source.url).toBe('/api/events');
    expect(source.options).toEqual({ withCredentials: true });
    act(() => {
      source.emit('open');
      source.emit('job', JSON.stringify({ id: 'job-1' }));
      source.emit('prompt', JSON.stringify({ id: 'prompt-1' }));
    });
    expect(screen.getByText('true:ok')).toBeVisible();
    expect(onJob).toHaveBeenCalledWith({ id: 'job-1' });
    expect(onPrompt).toHaveBeenCalledWith({ id: 'prompt-1' });
    act(() => source.emit('error'));
    expect(screen.getByText(/false:Event stream disconnected/)).toBeVisible();
    view.unmount();
    expect(source.closed).toBe(true);
  });

  it('handles malformed events and disabled state', () => {
    const view = render(<Probe callbacks={{}} />);
    const source = MockEventSource.instances[0]!;
    act(() => {
      source.readyState = MockEventSource.OPEN;
      source.emit('job', '{bad');
      source.emit('prompt', '{bad');
    });
    expect(screen.getByText(/true:.*JSON/)).toBeVisible();
    view.rerender(<Probe callbacks={{}} enabled={false} />);
    expect(screen.getByText('false:ok')).toBeVisible();
  });
});

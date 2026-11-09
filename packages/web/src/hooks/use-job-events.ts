import { useEffect, useRef, useState } from 'react';

export interface JobLogEvent {
  readonly jobId: string;
  readonly seq: number;
  readonly ts: string;
  readonly stream: 'stdout' | 'stderr' | 'system';
  readonly text: string;
}

export interface JobEventCallbacks {
  readonly onLog?: ((event: JobLogEvent) => void) | undefined;
  readonly onJob?: ((event: unknown) => void) | undefined;
  readonly onPrompt?: ((event: unknown) => void) | undefined;
}

export interface JobEventState {
  readonly connected: boolean;
  readonly error: string | null;
}

function cursorKey(jobId: string): string {
  return `hacm-job-event:${jobId}`;
}

function readCursor(jobId: string): number {
  if (typeof window === 'undefined') return 0;
  const value = Number.parseInt(
    window.localStorage.getItem(cursorKey(jobId)) ?? '0',
    10,
  );
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function resetJobEventCursor(jobId: string): void {
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(cursorKey(jobId));
  }
}

export function useJobEvents(
  jobId: string | null,
  callbacks: JobEventCallbacks = {},
  enabled = true,
): JobEventState {
  const callbacksRef = useRef(callbacks);
  const [state, setState] = useState<JobEventState>({
    connected: false,
    error: null,
  });

  useEffect(() => {
    callbacksRef.current = callbacks;
  }, [callbacks]);

  useEffect(() => {
    if (!enabled || !jobId) {
      setState({ connected: false, error: null });
      return;
    }
    let lastSeq = readCursor(jobId);
    const query = lastSeq > 0 ? `?after=${lastSeq}` : '';
    const source = new EventSource(
      `/api/jobs/${encodeURIComponent(jobId)}/events${query}`,
      { withCredentials: true },
    );

    const parse = (event: MessageEvent<string>): unknown => {
      try {
        return JSON.parse(event.data) as unknown;
      } catch (error) {
        setState({
          connected: source.readyState === EventSource.OPEN,
          error: String(error),
        });
        return undefined;
      }
    };
    const onLog = (raw: Event) => {
      const parsed = parse(raw as MessageEvent<string>) as
        JobLogEvent | undefined;
      if (!parsed || parsed.seq <= lastSeq) return;
      lastSeq = parsed.seq;
      window.localStorage.setItem(cursorKey(jobId), String(lastSeq));
      callbacksRef.current.onLog?.(parsed);
    };
    const onJob = (raw: Event) => {
      const parsed = parse(raw as MessageEvent<string>);
      if (parsed !== undefined) callbacksRef.current.onJob?.(parsed);
    };
    const onPrompt = (raw: Event) => {
      const parsed = parse(raw as MessageEvent<string>);
      if (parsed !== undefined) callbacksRef.current.onPrompt?.(parsed);
    };
    const onOpen = () => setState({ connected: true, error: null });
    const onError = () =>
      setState({ connected: false, error: 'Event stream disconnected.' });

    source.addEventListener('log', onLog);
    source.addEventListener('job', onJob);
    source.addEventListener('prompt', onPrompt);
    source.addEventListener('open', onOpen);
    source.addEventListener('error', onError);

    return () => {
      source.close();
      setState({ connected: false, error: null });
    };
  }, [enabled, jobId]);

  return state;
}

import { useEffect, useRef, useState } from 'react';

export interface QueueEventCallbacks {
  readonly onJob?: ((event: unknown) => void) | undefined;
  readonly onPrompt?: ((event: unknown) => void) | undefined;
}

export interface QueueEventState {
  readonly connected: boolean;
  readonly error: string | null;
}

export function useQueueEvents(
  callbacks: QueueEventCallbacks = {},
  enabled = true,
): QueueEventState {
  const callbacksRef = useRef(callbacks);
  const [state, setState] = useState<QueueEventState>({
    connected: false,
    error: null,
  });

  useEffect(() => {
    callbacksRef.current = callbacks;
  }, [callbacks]);

  useEffect(() => {
    if (!enabled) {
      setState({ connected: false, error: null });
      return;
    }
    const source = new EventSource('/api/events', { withCredentials: true });
    const parse = (event: Event): unknown => {
      try {
        return JSON.parse((event as MessageEvent<string>).data) as unknown;
      } catch (error) {
        setState({
          connected: source.readyState === EventSource.OPEN,
          error: String(error),
        });
        return undefined;
      }
    };
    const onJob = (event: Event) => {
      const parsed = parse(event);
      if (parsed !== undefined) callbacksRef.current.onJob?.(parsed);
    };
    const onPrompt = (event: Event) => {
      const parsed = parse(event);
      if (parsed !== undefined) callbacksRef.current.onPrompt?.(parsed);
    };
    const onOpen = () => setState({ connected: true, error: null });
    const onError = () =>
      setState({ connected: false, error: 'Event stream disconnected.' });
    source.addEventListener('job', onJob);
    source.addEventListener('prompt', onPrompt);
    source.addEventListener('open', onOpen);
    source.addEventListener('error', onError);
    return () => {
      source.close();
      setState({ connected: false, error: null });
    };
  }, [enabled]);

  return state;
}

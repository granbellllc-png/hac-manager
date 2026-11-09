import { useMemo, useRef, useState } from 'react';
import type { JobLogEvent } from '../hooks/use-job-events';
import { cn } from '../lib/utils';
import { Button } from './ui/button';

const ROW_HEIGHT = 24;
const OVERSCAN = 12;

export function VirtualLogViewer({
  lines,
  height = 420,
}: {
  readonly lines: readonly JobLogEvent[];
  readonly height?: number | undefined;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const visible = useMemo(() => {
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const count = Math.ceil(height / ROW_HEIGHT) + OVERSCAN * 2;
    return {
      start,
      end: Math.min(lines.length, start + count),
    };
  }, [height, lines.length, scrollTop]);

  const jumpToLatest = () => {
    const viewport = viewportRef.current!;
    viewport.scrollTop = Math.max(0, lines.length * ROW_HEIGHT - height);
    setScrollTop(viewport.scrollTop);
  };

  if (lines.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
        No log lines yet.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-neutral-950 text-neutral-100">
      <div className="flex justify-end border-b border-neutral-800 bg-neutral-900 p-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 bg-neutral-800 text-xs text-neutral-100 hover:bg-neutral-700"
          onClick={jumpToLatest}
        >
          Jump to latest
        </Button>
      </div>
      <div
        ref={viewportRef}
        role="log"
        aria-label="Job log"
        className="overflow-auto font-mono text-xs"
        style={{ height }}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <div
          className="relative min-w-max"
          style={{ height: lines.length * ROW_HEIGHT }}
        >
          {lines.slice(visible.start, visible.end).map((line, index) => (
            <div
              key={line.seq}
              data-testid="virtual-log-row"
              className={cn(
                'absolute right-0 left-0 flex h-6 items-center gap-3 px-3 whitespace-pre',
                line.stream === 'stderr' && 'text-red-300',
                line.stream === 'system' && 'text-sky-300',
              )}
              style={{ top: (visible.start + index) * ROW_HEIGHT }}
            >
              <span className="w-14 shrink-0 text-right text-neutral-500">
                {line.seq}
              </span>
              <span className="w-16 shrink-0 uppercase text-neutral-500">
                {line.stream}
              </span>
              <span>{line.text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

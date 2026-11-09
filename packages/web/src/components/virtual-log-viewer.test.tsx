import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { JobLogEvent } from '../hooks/use-job-events';
import { VirtualLogViewer } from './virtual-log-viewer';

function lines(count: number): JobLogEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    jobId: 'job-1',
    seq: index + 1,
    ts: '2026-01-01T00:00:00.000Z',
    stream: index % 10 === 0 ? 'stderr' : 'stdout',
    text: `line ${index + 1}`,
  }));
}

describe('VirtualLogViewer', () => {
  it('renders an empty state', () => {
    render(<VirtualLogViewer lines={[]} />);
    expect(screen.getByText('No log lines yet.')).toBeVisible();
  });

  it('virtualises long logs and updates the visible window on scroll', () => {
    render(<VirtualLogViewer lines={lines(10_000)} height={240} />);
    expect(screen.getAllByTestId('virtual-log-row').length).toBeLessThan(50);
    const log = screen.getByRole('log');
    fireEvent.scroll(log, { target: { scrollTop: 120_000 } });
    expect(screen.getByText('line 5001')).toBeVisible();
    expect(screen.queryByText('line 1')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }));
    expect(screen.getByText('line 10000')).toBeVisible();
  });
});

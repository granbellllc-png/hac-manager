import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditPage } from './audit';

describe('AuditPage component', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((req: Request | string) => {
        const url = typeof req === 'string' ? req : req.url;
        if (url.includes('/api/audit')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                items: [
                  {
                    id: 'audit-1',
                    userId: 'u1',
                    username: 'alice',
                    hostId: 'pve-01',
                    vmid: 101,
                    action: 'guest.apply',
                    reason: 'manual',
                    jobId: 'job-1',
                    diffJson: JSON.stringify({ cores: { old: 2, new: 4 } }),
                    metadataJson: null,
                    createdAt: new Date().toISOString(),
                  },
                ],
                total: 1,
                limit: 20,
                offset: 0,
              }),
              { headers: { 'content-type': 'application/json' } },
            ),
          );
        }
        return Promise.resolve(new Response(JSON.stringify({})));
      }),
    );
  });

  it('renders audit log records, filters and expands diff viewer', async () => {
    const user = userEvent.setup();
    render(<AuditPage />);

    expect(screen.getByRole('heading', { name: 'Audit' })).toBeInTheDocument();
    expect(screen.getByText('Loading audit logs...')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('guest.apply')).toBeInTheDocument();
    });

    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(screen.getByText(/pve-01/)).toBeInTheDocument();

    // Click "View Diff" button
    const diffButton = screen.getByRole('button', { name: 'View Diff' });
    await user.click(diffButton);

    const diffViewer = screen.getByTestId('diff-viewer');
    expect(diffViewer).toBeInTheDocument();
    expect(diffViewer).toHaveTextContent('"cores"');

    // Close diff viewer
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByTestId('diff-viewer')).toBeNull();

    // Test filter inputs
    const hostInput = screen.getByLabelText('Host');
    await user.type(hostInput, 'pve-02');
    expect(hostInput).toHaveValue('pve-02');

    // Reset filters
    await user.click(screen.getByRole('button', { name: 'Reset Filters' }));
    expect(hostInput).toHaveValue('');
  });

  it('renders empty state when no records are returned', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            items: [],
            total: 0,
            limit: 20,
            offset: 0,
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    render(<AuditPage />);
    await waitFor(() => {
      expect(
        screen.getByText('No audit records found matching your filters.'),
      ).toBeInTheDocument();
    });
  });

  it('renders error state on API failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('Internal Server Error', { status: 500 }),
        ),
    );

    render(<AuditPage />);
    await waitFor(() => {
      expect(
        screen.getByText('Failed to load audit records.'),
      ).toBeInTheDocument();
    });
  });
});

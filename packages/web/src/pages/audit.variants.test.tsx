import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditPage } from './audit';

const fixture = {
  id: 'fixture-audit',
  userId: null,
  username: null,
  hostId: null,
  vmid: null,
  action: 'fixture.action',
  reason: 'manual',
  jobId: null,
  diffJson: null,
  metadataJson: null,
  createdAt: '2026-01-01T00:00:00Z',
};
afterEach(() => vi.unstubAllGlobals());

describe('audit filtering and detail variants', () => {
  it('filters by VMID, actor and reason, paginates, and displays metadata without a diff', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        items: [{ ...fixture, metadataJson: '{"fixture":"metadata"}' }],
        total: 41,
        limit: 20,
        offset: 0,
      }),
    );
    vi.stubGlobal('fetch', fetchFn);
    render(<AuditPage />);
    await screen.findByText('fixture.action');
    expect(screen.getByText('system')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Page 2 of 3');
    await user.click(screen.getByRole('button', { name: 'Previous' }));
    await screen.findByText('Page 1 of 3');
    fireEvent.change(screen.getByLabelText('VMID'), {
      target: { value: '112' },
    });
    fireEvent.change(screen.getByLabelText('User'), {
      target: { value: 'fixture-user' },
    });
    await user.selectOptions(screen.getByLabelText('Reason'), 'drift_pull');
    await screen.findByText('fixture.action');
    await waitFor(() => {
      const request = fetchFn.mock.calls.at(-1)?.[0] as Request;
      const query = new URL(request.url).searchParams;
      expect(query.get('vmid')).toBe('112');
      expect(query.get('username')).toBe('fixture-user');
      expect(query.get('reason')).toBe('drift_pull');
    });
    await user.click(screen.getByRole('button', { name: 'View Diff' }));
    expect(screen.getByTestId('diff-viewer')).toHaveTextContent('metadata');
    await user.click(screen.getByRole('button', { name: 'Hide' }));
    expect(screen.queryByTestId('diff-viewer')).toBeNull();
  });

  it('handles records with no payload and host-only targets', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () =>
        Response.json({
          items: [{ ...fixture, hostId: 'fixture-host' }],
          total: 1,
          limit: 20,
          offset: 0,
        }),
      ),
    );
    render(<AuditPage />);
    expect(await screen.findByText('fixture-host')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'View Diff' })).toBeNull();
  });

  it('handles an expanded record disappearing after a filter refresh', async () => {
    let items = [{ ...fixture, metadataJson: '{"fixture":"metadata"}' }];
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(async () =>
          Response.json({ items, total: 1, limit: 20, offset: 0 }),
        ),
    );
    render(<AuditPage />);
    await screen.findByText('fixture.action');
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'View Diff' }));
    items = [{ ...fixture, id: 'replacement', metadataJson: '{}' }];
    fireEvent.change(screen.getByLabelText('User'), {
      target: { value: 'replacement-user' },
    });
    await waitFor(() =>
      expect(screen.getByTestId('diff-viewer')).not.toHaveTextContent(
        'metadata',
      ),
    );
  });

  it('reports network failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('fixture offline')),
    );
    render(<AuditPage />);
    expect(
      await screen.findByText(
        'An error occurred while fetching audit records.',
      ),
    ).toBeInTheDocument();
  });
});

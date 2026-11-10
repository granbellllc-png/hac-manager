import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditPage, safeFormatAuditPayload } from './audit';

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

  it('guards audit diff rendering against malformed diffJson', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () =>
        Response.json({
          items: [{ ...fixture, diffJson: '{"invalid: json' }],
          total: 1,
          limit: 20,
          offset: 0,
        }),
      ),
    );
    render(<AuditPage />);
    await screen.findByText('fixture.action');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'View Diff' }));
    expect(screen.getByTestId('diff-viewer')).toHaveTextContent(
      'Payload could not be decoded.',
    );
  });

  it('guards audit diff rendering against malformed metadataJson', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () =>
        Response.json({
          items: [
            { ...fixture, diffJson: null, metadataJson: 'not valid json' },
          ],
          total: 1,
          limit: 20,
          offset: 0,
        }),
      ),
    );
    render(<AuditPage />);
    await screen.findByText('fixture.action');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'View Diff' }));
    expect(screen.getByTestId('diff-viewer')).toHaveTextContent(
      'Payload could not be decoded.',
    );
  });

  it('guards audit diff rendering when payload is missing', async () => {
    expect(safeFormatAuditPayload('', '')).toEqual({
      ok: false,
      error: 'Payload could not be decoded.',
    });
    expect(safeFormatAuditPayload(null, null)).toEqual({
      ok: false,
      error: 'Payload could not be decoded.',
    });
  });

  it('keeps other records and filters usable when one record has malformed JSON', async () => {
    const row1 = {
      ...fixture,
      id: 'bad-row',
      action: 'bad.action',
      diffJson: '{bad',
    };
    const row2 = {
      ...fixture,
      id: 'good-row',
      action: 'good.action',
      diffJson: '{"valid": true}',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () =>
        Response.json({
          items: [row1, row2],
          total: 2,
          limit: 20,
          offset: 0,
        }),
      ),
    );
    render(<AuditPage />);
    await screen.findByText('bad.action');
    expect(screen.getByText('good.action')).toBeInTheDocument();
    const user = userEvent.setup();
    const viewButtons = screen.getAllByRole('button', { name: 'View Diff' });
    // Expand bad row
    await user.click(viewButtons[0]);
    expect(screen.getByTestId('diff-viewer')).toHaveTextContent(
      'Payload could not be decoded.',
    );
    // Expand good row
    await user.click(viewButtons[1]);
    expect(screen.getByTestId('diff-viewer')).toHaveTextContent(
      '"valid": true',
    );
    // Filters remain usable
    const hostInput = screen.getByLabelText('Host');
    await user.type(hostInput, 'pve-99');
    expect(hostInput).toHaveValue('pve-99');
  });
});

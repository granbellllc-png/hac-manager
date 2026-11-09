import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureHost, fixtureGuests } from '../../fixtures/hosts';
import { ResourcesPage } from './resources';

afterEach(() => {
  vi.unstubAllGlobals();
});

function Destination() {
  const location = useLocation();
  return (
    <div data-testid="destination">{location.pathname + location.search}</div>
  );
}

function renderResources(initialEntry = '/resources') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/resources" element={<ResourcesPage />} />
        <Route path="/resources/:hostId/:vmid" element={<Destination />} />
      </Routes>
    </MemoryRouter>,
  );
}

function installApi({
  guests = fixtureGuests,
  guestFailure,
  refreshFailure,
}: {
  readonly guests?: readonly Record<string, unknown>[];
  readonly guestFailure?: 'http' | 'network' | 'non-error';
  readonly refreshFailure?: 'http' | 'network';
} = {}) {
  const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const request = input as Request;
    const path = new URL(request.url).pathname;
    if (path === '/api/inventory/guests') {
      if (guestFailure === 'http') return Response.json({}, { status: 500 });
      if (guestFailure === 'network') throw new Error('fixture offline');
      if (guestFailure === 'non-error') throw 'fixture offline';
      return Response.json({ guests });
    }
    if (path === '/api/hosts') return Response.json({ hosts: [fixtureHost] });
    if (path === '/api/inventory/refresh') {
      if (refreshFailure === 'http') return Response.json({}, { status: 500 });
      if (refreshFailure === 'network') throw new Error('fixture offline');
      return Response.json({
        refreshed: true,
        timestamp: '2026-01-01T00:00:00Z',
      });
    }
    return Response.json({});
  });
  vi.stubGlobal('fetch', fetchFn);
  return fetchFn;
}

describe('ResourcesPage', () => {
  it(
    'renders more than 100 guests in pages and applies every filter',
    { timeout: 20_000 },
    async () => {
      const guests = Array.from({ length: 105 }, (_, index) => ({
        hostId: index === 104 ? 'unknown-host' : fixtureHost.id,
        vmid: 1000 + index,
        name: `Guest ${String(index).padStart(3, '0')}`,
        type: index % 2 === 0 ? ('lxc' as const) : ('vm' as const),
        status:
          index % 3 === 0 ? 'running' : index % 3 === 1 ? 'stopped' : 'paused',
        node: 'fixture-node',
        ...(index % 7 === 0 ? {} : { maxcpu: 2, maxmem: 1024 ** 3 }),
        configuration:
          index % 5 === 0
            ? { status: 'orphan' as const }
            : {
                status: 'configured' as const,
                relativePath: `hosts/fixture-host/${1000 + index}-guest/deployment.yaml`,
              },
      }));
      installApi({ guests });
      const user = userEvent.setup();
      renderResources();

      expect(
        await screen.findByText('Showing 1–50 of 105 resources'),
      ).toBeVisible();
      expect(screen.getAllByRole('link', { name: 'View guest' })).toHaveLength(
        50,
      );
      expect(screen.getByRole('alert')).toHaveTextContent(
        '21 live guests have',
      );
      expect(screen.getAllByText('paused').length).toBeGreaterThan(0);

      await user.click(screen.getByRole('button', { name: 'Next' }));
      expect(screen.getByText('Showing 51–100 of 105 resources')).toBeVisible();
      await user.click(screen.getByRole('button', { name: 'Previous' }));

      await user.selectOptions(screen.getByLabelText('Type'), 'vm');
      expect(screen.getByText(/of 52 resources/)).toBeVisible();
      await user.selectOptions(screen.getByLabelText('Status'), 'stopped');
      await user.selectOptions(
        screen.getByLabelText('Configuration'),
        'orphan',
      );
      expect(
        screen.getAllByRole('link', { name: 'View guest' }).length,
      ).toBeGreaterThan(0);

      await user.selectOptions(screen.getByLabelText('Host'), fixtureHost.id);
      await user.type(
        screen.getByPlaceholderText('Name, VMID, or host'),
        'Guest 025',
      );
      expect(screen.getByRole('heading', { name: 'Guest 025' })).toBeVisible();
      await user.clear(screen.getByPlaceholderText('Name, VMID, or host'));
      await user.selectOptions(screen.getByLabelText('Type'), '');
      await user.selectOptions(screen.getByLabelText('Status'), '');
      await user.selectOptions(screen.getByLabelText('Configuration'), '');
      await user.selectOptions(screen.getByLabelText('Host'), '');
      await user.type(
        screen.getByPlaceholderText('Name, VMID, or host'),
        'Guest 104',
      );

      const unknownCard = screen
        .getByRole('heading', { name: 'Guest 104' })
        .closest('article');
      expect(unknownCard).not.toBeNull();
      expect(within(unknownCard!).getByText(/unknown-host/)).toBeVisible();
      await user.click(
        within(unknownCard!).getByRole('link', { name: 'View guest' }),
      );
      expect(screen.getByTestId('destination')).toHaveTextContent(
        '/resources/unknown-host/1104?type=lxc',
      );
    },
  );

  it('labels the search field and orders guests by VMID', async () => {
    installApi({
      guests: [
        { ...fixtureGuests[0], vmid: 900, name: 'Zulu' },
        { ...fixtureGuests[0], vmid: 100, name: 'Alpha' },
        { ...fixtureGuests[0], vmid: 500, name: 'Mike' },
      ],
    });
    renderResources();

    expect(await screen.findByRole('heading', { name: 'Alpha' })).toBeVisible();
    expect(screen.getByText('Search')).toBeVisible();
    expect(
      screen
        .getAllByRole('heading', { level: 2 })
        .map((node) => node.textContent),
    ).toEqual(['Alpha', 'Mike', 'Zulu']);
  });

  it('loads URL filters, refreshes inventory, and renders a singular orphan alert', async () => {
    const fetchFn = installApi({ guests: [fixtureGuests[1]!] });
    const user = userEvent.setup();
    renderResources('/resources?type=vm&configuration=orphan');

    expect(
      await screen.findByRole('heading', { name: 'Unmanaged VM' }),
    ).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('1 live guest has');
    await user.click(screen.getByRole('button', { name: 'Refresh inventory' }));
    await waitFor(() =>
      expect(
        fetchFn.mock.calls.some(
          ([request]) =>
            new URL((request as Request).url).pathname ===
              '/api/inventory/refresh' &&
            (request as Request).method === 'POST',
        ),
      ).toBe(true),
    );
  });

  it('shows the empty state when filters or inventory have no matches', async () => {
    installApi({ guests: [] });
    renderResources();
    expect(await screen.findByText('No resources match')).toBeVisible();
  });

  it.each([
    ['http', 'Unable to load guest resources.'],
    ['network', 'fixture offline'],
    ['non-error', 'fixture offline'],
  ] as const)('reports %s inventory failures', async (failure, message) => {
    installApi({ guestFailure: failure });
    renderResources();
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
  });

  it.each(['http', 'network'] as const)(
    'reports %s refresh failures',
    async (refreshFailure) => {
      installApi({ refreshFailure });
      renderResources();
      await screen.findByRole('heading', { name: 'Example LXC' });
      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: 'Refresh inventory' }));
      expect(
        await screen.findByText('Unable to refresh guest inventory.'),
      ).toBeVisible();
    },
  );
});

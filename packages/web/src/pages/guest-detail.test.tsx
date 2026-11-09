import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureGuestDetail, fixtureGuests } from '../../fixtures/hosts';
import {
  formatGuestBytes,
  formatGuestConfigValue,
  formatGuestUptime,
  GuestDetailPage,
} from './guest-detail';

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderDetail(path = '/resources/fixture-host/112?type=lxc') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/resources/:hostId/:vmid" element={<GuestDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function installDetailApi(
  response: unknown = fixtureGuestDetail,
  failure?: 'http' | 'network' | 'non-error',
) {
  const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => {
    if (failure === 'http') return Response.json({}, { status: 404 });
    if (failure === 'network') throw new Error('fixture offline');
    if (failure === 'non-error') throw 'fixture offline';
    return Response.json(response);
  });
  vi.stubGlobal('fetch', fetchFn);
  return fetchFn;
}

describe('guest detail helpers', () => {
  it('formats resource values and tagged configuration safely', () => {
    expect(formatGuestBytes(undefined)).toBe('Not reported');
    expect(formatGuestBytes(1024 ** 2)).toBe('1 MB');
    expect(formatGuestUptime(undefined)).toBe('Not reported');
    expect(formatGuestUptime(3600)).toBe('1h');
    expect(formatGuestUptime(90_000)).toBe('1d 1h');
    expect(formatGuestConfigValue(undefined)).toBe('Not set');
    expect(formatGuestConfigValue([1, 2])).toBe('2 configured');
    expect(
      formatGuestConfigValue({ tag: 'expr', value: 'host.index + 1' }),
    ).toBe('!expr host.index + 1');
    expect(formatGuestConfigValue({ tag: 'secret' })).toBe('!secret');
    expect(formatGuestConfigValue({ nested: true })).toBe('{"nested":true}');
    expect(formatGuestConfigValue(false)).toBe('false');
  });
});

describe('GuestDetailPage', () => {
  it('shows live/configured comparison and byte-preserved YAML in CodeMirror', async () => {
    const response = {
      ...fixtureGuestDetail,
      configuration: {
        ...fixtureGuestDetail.configuration,
        config: {
          ...fixtureGuestDetail.configuration.config,
          protection: { nested: true },
        },
        issues: [
          {
            path: 'network.0.ip',
            code: 'custom',
            message: 'Fixture warning',
          },
        ],
      },
    };
    const fetchFn = installDetailApi(response);
    renderDetail();

    expect(
      await screen.findByRole('heading', { name: 'Example LXC' }),
    ).toBeVisible();
    expect(screen.getByText('Uptime 1d 1h')).toBeVisible();
    expect(screen.getByText('17% current usage')).toBeVisible();
    expect(screen.getByText(/Fixture warning/)).toBeVisible();
    expect(screen.getAllByText('{"nested":true}')).toHaveLength(2);
    const yaml = screen.getByLabelText('Example LXC deployment YAML');
    expect(yaml).toHaveTextContent('Fixture comment must remain visible');
    expect(yaml).toHaveTextContent('host.index + 1');
    const request = fetchFn.mock.calls[0]?.[0] as Request;
    expect(new URL(request.url).searchParams.get('type')).toBe('lxc');
  });

  it('shows an orphan warning and missing live metrics without rendering YAML', async () => {
    installDetailApi({
      summary: {
        ...fixtureGuests[1],
        maxcpu: undefined,
        maxmem: undefined,
        mem: undefined,
        uptime: 3600,
      },
      rawConfig: '',
      canonicalConfig: {
        id: 212,
        name: 'Unmanaged VM',
        type: 'vm',
        cpu: 4,
        ram: 4096,
        disks: [],
        network: [],
      },
      source: 'api',
      configuration: { status: 'orphan' },
    });
    renderDetail('/resources/fixture-host/212?type=not-a-type');

    expect(await screen.findByText('Unmanaged guest (orphan)')).toBeVisible();
    expect(screen.getAllByText('Not reported').length).toBeGreaterThan(0);
    expect(screen.getAllByText('No YAML')).toHaveLength(10);
    expect(screen.getByText('No raw configuration returned.')).toBeVisible();
    expect(screen.queryByTestId('yaml-code-viewer')).toBeNull();
  });

  it('rejects an invalid route without making an API call', async () => {
    const fetchFn = installDetailApi();
    renderDetail('/resources/fixture-host/not-a-number');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Invalid guest route.',
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    ['http', 'Guest not found or access denied.'],
    ['network', 'fixture offline'],
    ['non-error', 'fixture offline'],
  ] as const)('reports %s guest detail failures', async (failure, message) => {
    installDetailApi(undefined, failure);
    renderDetail();
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
  });
});

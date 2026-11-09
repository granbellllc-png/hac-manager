import type { Page } from '@playwright/test';
import {
  fixtureHost,
  fixtureHostDetail,
  fixtureGuestDetail,
  fixtureGuests,
  fixtureProbe,
} from '../fixtures/hosts';

/** Intercept every API request so browser tests cannot reach a real host. */
export async function installFixtureApi(
  page: Page,
  mode: 'authenticated' | 'login' | 'setup' = 'authenticated',
) {
  let authenticated = mode === 'authenticated';
  let setupNeeded = mode === 'setup';
  const user = {
    id: 'fixture-user',
    username: 'fixture-user',
    role: 'admin',
    totpEnabled: false,
  };
  await page.route('**://*/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let body: unknown;
    let status = 200;
    if (path === '/api/auth/status')
      body = { setupNeeded, user: authenticated ? user : null };
    else if (path === '/api/auth/setup' || path === '/api/auth/login') {
      authenticated = true;
      setupNeeded = false;
      status = path.endsWith('/setup') ? 201 : 200;
      body = { message: 'Fixture session created', user };
    } else if (path === '/api/auth/logout') {
      authenticated = false;
      body = { message: 'Fixture session ended' };
    } else if (path === '/api/health')
      body = { status: 'ok', service: 'HAC Manager' };
    else if (path === '/api/hosts') body = { hosts: [fixtureHost] };
    else if (path === '/api/hosts/sync')
      body = { synced: 1, removed: 0, issues: [] };
    else if (path === '/api/inventory/hosts')
      body = {
        hosts: [
          {
            hostId: fixtureHost.id,
            name: fixtureHost.name,
            status: 'online',
            guestCount: 112,
            channels: {
              ssh: { ok: true, status: 'connected' },
              api: { ok: false, status: 'not_configured' },
            },
            lastRefreshedAt: fixtureHost.updatedAt,
          },
        ],
      };
    else if (path === '/api/inventory/guests') body = { guests: fixtureGuests };
    else if (path === '/api/inventory/guests/fixture-host/112')
      body = fixtureGuestDetail;
    else if (path.endsWith('/test-connection'))
      body = {
        ok: true,
        ssh: { ok: true, status: 'connected', latencyMs: 12 },
      };
    else if (path.endsWith('/probe')) body = fixtureProbe;
    else if (path === '/api/hosts/fixture-host')
      body = { host: fixtureHostDetail };
    else if (path === '/api/audit')
      body = {
        items: [
          {
            id: 'fixture-audit',
            userId: user.id,
            username: user.username,
            hostId: fixtureHost.id,
            vmid: 112,
            action: 'guest.import',
            reason: 'manual',
            jobId: null,
            diffJson: '{"cpu":{"before":1,"after":2}}',
            metadataJson: null,
            createdAt: fixtureHost.updatedAt,
          },
        ],
        total: 1,
        limit: 20,
        offset: 0,
      };
    else {
      status = 404;
      body = { message: 'Fixture endpoint not found' };
    }
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
}

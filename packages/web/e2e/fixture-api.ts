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
  let guestDetail = structuredClone(fixtureGuestDetail);
  const user = {
    id: 'fixture-user',
    username: 'fixture-user',
    role: 'admin',
    totpEnabled: false,
  };
  const fixtureJob = {
    id: 'fixture-job',
    hostId: fixtureHost.id,
    vmid: 112,
    lane: 'guest',
    type: 'plan.apply',
    status: 'running',
    priority: 0,
    triggeredBy: user.id,
    createdAt: fixtureHost.updatedAt,
    startedAt: fixtureHost.updatedAt,
  };
  await page.route('**://*/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/events' || path.endsWith('/events')) {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: 'retry: 60000\n\n: fixture\n\n',
      });
      return;
    }
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
    else if (path === '/api/config/schema/deployment')
      body = {
        schema: {
          oneOf: [
            {
              properties: {
                schema_version: { description: 'Schema version' },
                id: { description: 'VMID' },
                name: { description: 'Guest name' },
                type: { description: 'Guest type' },
                cpu: { description: 'CPU cores' },
                ram: { description: 'Memory in MB' },
              },
            },
          ],
        },
      };
    else if (path.endsWith('/validate'))
      body = {
        valid: true,
        issues: [],
        adminOnly: [],
        requiresAdmin: false,
      };
    else if (
      path === '/api/config/guests/fixture-host/112' &&
      request.method() === 'PUT'
    ) {
      const payload = request.postDataJSON() as {
        rawYaml: string;
        dryRun?: boolean;
      };
      if (payload.dryRun) {
        body = {
          success: true,
          dryRun: true,
          rawYaml: payload.rawYaml,
          hash: guestDetail.configuration.hash,
          config: guestDetail.configuration.config,
          issues: [],
        };
        await route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify(body),
        });
        return;
      }
      guestDetail = {
        ...guestDetail,
        configuration: {
          ...guestDetail.configuration,
          rawYaml: payload.rawYaml,
          hash: 'b'.repeat(64),
          config: {
            ...guestDetail.configuration.config,
            ram: 2048,
          },
        },
      };
      body = {
        success: true,
        dryRun: false,
        rawYaml: payload.rawYaml,
        hash: guestDetail.configuration.hash,
        config: guestDetail.configuration.config,
        issues: [],
      };
    } else if (path === '/api/inventory/guests/fixture-host/112')
      body = guestDetail;
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
    else if (path === '/api/jobs') body = { jobs: [fixtureJob] };
    else if (path === '/api/jobs/fixture-job')
      body = {
        job: fixtureJob,
        steps: [
          {
            jobId: fixtureJob.id,
            stepIndex: 0,
            name: 'Apply planned guest import',
            status: 'running',
            rollbackHint: 'Inspect the generated YAML.',
          },
        ],
        prompts: [],
      };
    else if (path === '/api/jobs/fixture-job/logs')
      body = {
        logs: [
          {
            jobId: fixtureJob.id,
            seq: 1,
            ts: fixtureHost.updatedAt,
            stream: 'system',
            text: 'Job started',
          },
          {
            jobId: fixtureJob.id,
            seq: 2,
            ts: fixtureHost.updatedAt,
            stream: 'stdout',
            text: 'Applying planned change',
          },
        ],
        nextCursor: 2,
      };
    else if (path === '/api/prompts') body = { prompts: [] };
    else if (path === '/api/jobs/fixture-job/cancel')
      body = { job: { ...fixtureJob, status: 'cancelled' } };
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

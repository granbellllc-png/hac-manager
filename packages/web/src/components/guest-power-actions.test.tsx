import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GuestPowerActions } from './guest-power-actions';

interface ApplyCall {
  readonly planId: string;
  readonly body: unknown;
}

function planFor(action: string) {
  const destructive = action !== 'start';
  return {
    id: `plan-${action}`,
    operation: 'guest.power',
    target: { hostId: 'pve-01', vmid: 112, resourceType: 'guest' },
    summary: `${action[0]!.toUpperCase()}${action.slice(1)} guest 112`,
    changes: [],
    warnings: [],
    destructive,
    stateFingerprint: 'a'.repeat(64),
    ...(destructive
      ? { confirmationText: `${action.toUpperCase()} pve-01/112` }
      : {}),
    createdAt: new Date().toISOString(),
    status: 'ready',
  };
}

function installPowerApi(
  options: {
    readonly failPlan?: 'message' | 'empty' | 'non-string';
    readonly failApply?: boolean;
    readonly throwPlan?: boolean;
    readonly throwApply?: boolean;
  } = {},
) {
  const applyCalls: ApplyCall[] = [];
  let requestedAction = 'start';
  const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const request = input as Request;
    const url = new URL(request.url);
    if (
      request.method === 'POST' &&
      url.pathname === '/api/plans/guest-power'
    ) {
      if (options.throwPlan) throw 'plan offline';
      if (options.failPlan) {
        const body =
          options.failPlan === 'message'
            ? { message: 'The guest hosting HAC Manager is protected' }
            : options.failPlan === 'non-string'
              ? { message: 42 }
              : {};
        return Response.json(body, { status: 403 });
      }
      const body = (await request.json()) as { action: string };
      requestedAction = body.action;
      return Response.json(planFor(body.action), { status: 201 });
    }
    if (request.method === 'POST' && url.pathname.endsWith('/apply')) {
      if (options.throwApply) throw new Error('apply offline');
      if (options.failApply) {
        return Response.json({ message: 'apply denied' }, { status: 409 });
      }
      const planId = url.pathname.split('/').at(-2) ?? '';
      applyCalls.push({ planId, body: await request.json() });
      return Response.json(
        {
          plan: { ...planFor(requestedAction), status: 'applying' },
          job: { id: 'job-1' },
        },
        { status: 202 },
      );
    }
    return Response.json({}, { status: 404 });
  });
  vi.stubGlobal('fetch', fetchFn);
  return { applyCalls, fetchFn };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderActions(status = 'running', role = 'admin') {
  return render(
    <GuestPowerActions
      hostId="pve-01"
      vmid={112}
      name="Example LXC"
      status={status}
      role={role}
    />,
  );
}

describe('GuestPowerActions', () => {
  it('requires the exact typed confirmation before queuing a destructive action', async () => {
    const { applyCalls } = installPowerApi();
    const user = userEvent.setup();
    renderActions('running');

    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Stop' }));

    expect(await screen.findByText('STOP pve-01/112')).toBeVisible();
    const confirm = screen.getByRole('button', { name: 'Confirm and queue' });
    expect(confirm).toBeDisabled();

    const input = screen.getByLabelText('Typed confirmation');
    await user.type(input, 'stop');
    expect(confirm).toBeDisabled();
    await user.clear(input);
    await user.type(input, 'STOP pve-01/112');
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    expect(await screen.findByRole('status')).toHaveTextContent(
      'was queued as job job-1',
    );
    expect(applyCalls).toEqual([
      { planId: 'plan-stop', body: { confirmation: 'STOP pve-01/112' } },
    ]);
  });

  it('applies a non-destructive start immediately', async () => {
    const { applyCalls } = installPowerApi();
    const user = userEvent.setup();
    renderActions('stopped');

    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Start' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Start guest 112 was queued',
    );
    expect(applyCalls).toEqual([{ planId: 'plan-start', body: {} }]);
  });

  it('keeps viewers read-only and surfaces server errors', async () => {
    installPowerApi();
    const { unmount } = renderActions('running', 'viewer');
    expect(screen.getByText(/Viewers can inspect/)).toBeVisible();
    for (const name of ['Start', 'Shutdown', 'Reboot', 'Stop']) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
    unmount();

    installPowerApi({ failPlan: 'message' });
    const user = userEvent.setup();
    renderActions('running');
    await user.click(screen.getByRole('button', { name: 'Reboot' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The guest hosting HAC Manager is protected',
    );
  });

  it('cancels a destructive confirmation without queueing anything', async () => {
    const { applyCalls } = installPowerApi();
    const user = userEvent.setup();
    renderActions('running');
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    await screen.findByText('STOP pve-01/112');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Typed confirmation')).toBeNull();
    expect(applyCalls).toEqual([]);
  });

  it('reports apply failures for both non-destructive and confirmed actions', async () => {
    installPowerApi({ failApply: true });
    const user = userEvent.setup();
    const { unmount } = renderActions('stopped');
    await user.click(screen.getByRole('button', { name: 'Start' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('apply denied');
    unmount();

    installPowerApi({ throwApply: true });
    renderActions('running');
    await user.click(screen.getByRole('button', { name: 'Shutdown' }));
    await screen.findByText('SHUTDOWN pve-01/112');
    await user.type(
      screen.getByLabelText('Typed confirmation'),
      'SHUTDOWN pve-01/112',
    );
    await user.click(screen.getByRole('button', { name: 'Confirm and queue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('apply offline');
  });

  it('falls back to a stable message when plan errors are not usable', async () => {
    const user = userEvent.setup();
    for (const mode of ['empty', 'non-string'] as const) {
      installPowerApi({ failPlan: mode });
      const view = renderActions('running');
      await user.click(screen.getByRole('button', { name: 'Reboot' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Unable to create a power plan.',
      );
      view.unmount();
    }

    installPowerApi({ throwPlan: true });
    renderActions('running');
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('plan offline');
  });
});

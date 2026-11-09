import { useState } from 'react';
import { Power, Play, RotateCcw, Square, type LucideIcon } from 'lucide-react';
import { apiClient } from '../api/client';
import type { paths } from '../api/schema';
import { Button } from './ui/button';

type GuestPowerPlan =
  paths['/api/plans/guest-power']['post']['responses']['201']['content']['application/json'];

export type GuestPowerAction = 'start' | 'stop' | 'shutdown' | 'reboot';

interface PowerActionOption {
  readonly action: GuestPowerAction;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly description: string;
  readonly destructive: boolean;
}

const POWER_ACTIONS: readonly PowerActionOption[] = [
  {
    action: 'start',
    label: 'Start',
    icon: Play,
    description: 'Boot the guest.',
    destructive: false,
  },
  {
    action: 'shutdown',
    label: 'Shutdown',
    icon: Power,
    description: 'Ask the guest OS to shut down cleanly.',
    destructive: true,
  },
  {
    action: 'reboot',
    label: 'Reboot',
    icon: RotateCcw,
    description: 'Restart the guest.',
    destructive: true,
  },
  {
    action: 'stop',
    label: 'Stop',
    icon: Square,
    description: 'Hard stop the guest immediately.',
    destructive: true,
  },
];

function errorMessage(value: unknown, fallback: string): string {
  if (typeof value === 'object' && value !== null && 'message' in value) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return fallback;
}

export function GuestPowerActions({
  hostId,
  vmid,
  name,
  status,
  role,
}: {
  readonly hostId: string;
  readonly vmid: number;
  readonly name: string;
  readonly status: string;
  readonly role: string;
}) {
  const [pendingPlan, setPendingPlan] = useState<GuestPowerPlan | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{
    readonly tone: 'error' | 'success';
    readonly text: string;
  } | null>(null);

  const applyPlan = async (
    plan: GuestPowerPlan,
    typedConfirmation?: string,
  ): Promise<void> => {
    const result = await apiClient.POST('/api/plans/{planId}/apply', {
      params: { path: { planId: plan.id } },
      body:
        typedConfirmation === undefined
          ? {}
          : { confirmation: typedConfirmation },
    });
    if (result.error || !result.data) {
      setFeedback({
        tone: 'error',
        text: errorMessage(result.error, 'Unable to queue the power job.'),
      });
      return;
    }
    setPendingPlan(null);
    setConfirmation('');
    setFeedback({
      tone: 'success',
      text: `${plan.summary} was queued as job ${result.data.job.id}. Open Jobs to follow its progress.`,
    });
  };

  const requestPower = async (option: PowerActionOption): Promise<void> => {
    setBusy(true);
    setFeedback(null);
    try {
      const result = await apiClient.POST('/api/plans/guest-power', {
        body: { hostId, vmid, action: option.action },
      });
      if (result.error || !result.data) {
        setFeedback({
          tone: 'error',
          text: errorMessage(result.error, 'Unable to create a power plan.'),
        });
        return;
      }
      if (result.data.destructive) {
        setPendingPlan(result.data);
        setConfirmation('');
        return;
      }
      await applyPlan(result.data);
    } catch (error) {
      setFeedback({
        tone: 'error',
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const cancelConfirmation = () => {
    setPendingPlan(null);
    setConfirmation('');
  };

  const confirmPower = async (plan: GuestPowerPlan): Promise<void> => {
    setBusy(true);
    try {
      await applyPlan(plan, confirmation);
    } catch (error) {
      setFeedback({
        tone: 'error',
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const viewer = role === 'viewer';
  const running = status === 'running';
  const stopped = status === 'stopped';
  const expectedConfirmation = pendingPlan?.confirmationText ?? '';

  return (
    <section
      className="space-y-3 rounded-lg border bg-card p-4"
      aria-label="Power actions"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Power actions</h2>
          <p className="text-sm text-muted-foreground">
            Queued as durable jobs. Destructive actions need a typed
            confirmation.
          </p>
        </div>
        <span className="rounded bg-muted px-2 py-1 text-xs font-medium uppercase text-muted-foreground">
          {status}
        </span>
      </div>

      {feedback && (
        <div
          role={feedback.tone === 'error' ? 'alert' : 'status'}
          className={
            feedback.tone === 'error'
              ? 'rounded-md border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-700 dark:text-rose-300'
              : 'rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300'
          }
        >
          {feedback.text}
        </div>
      )}

      {viewer && (
        <p className="text-sm text-muted-foreground">
          Viewers can inspect the guest but cannot change its power state.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {POWER_ACTIONS.map((option) => {
          const blocked = option.action === 'start' ? running : stopped;
          return (
            <Button
              key={option.action}
              variant="outline"
              size="sm"
              title={
                viewer
                  ? 'Viewers have read-only access'
                  : blocked
                    ? `${option.label} is unavailable while the guest is ${status}`
                    : option.description
              }
              className={
                option.destructive
                  ? 'text-rose-600 hover:text-rose-700 dark:text-rose-400'
                  : undefined
              }
              disabled={viewer || busy || pendingPlan !== null || blocked}
              onClick={() => void requestPower(option)}
            >
              <option.icon aria-hidden className="h-4 w-4" />
              {option.label}
            </Button>
          );
        })}
      </div>

      {pendingPlan && (
        <div className="space-y-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
          <p className="text-sm">
            This change is destructive. Type{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
              {pendingPlan.confirmationText ?? pendingPlan.id}
            </code>{' '}
            to confirm {name}.
          </p>
          <label className="block text-sm font-medium" htmlFor="power-confirm">
            Typed confirmation
          </label>
          <input
            id="power-confirm"
            className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy || confirmation !== expectedConfirmation}
              onClick={() => void confirmPower(pendingPlan)}
            >
              Confirm and queue
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={cancelConfirmation}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

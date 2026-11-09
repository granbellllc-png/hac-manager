import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Secret } from '../tags/secret.js';
import { globalSecretRedactor } from '../redaction/redactor.js';
import { createMutationPlan, executeMutationPlan } from './plan.js';
import { fingerprintPlanState } from './fingerprint.js';
import { parseMutationPlan } from './schema.js';
import {
  PlanCancelledError,
  PlanValidationError,
  StalePlanError,
} from './types.js';

const goldenPath = resolve(
  import.meta.dirname,
  '../../fixtures/plans/guest-import-plan.json',
);

describe('mutation plans', () => {
  it('matches the redacted golden plan for a fixture change', async () => {
    const plan = createMutationPlan({
      id: 'plan-fixture-001',
      operation: 'guest.import',
      target: { hostId: 'pve-01', vmid: 112, resourceType: 'guest' },
      summary: 'Import LXC 112 into YAML',
      currentState: {
        live: { vmid: 112, memory: 2048, password: new Secret('live-secret') },
        target: null,
      },
      changes: [
        {
          id: 'deployment-file',
          action: 'create',
          path: 'hosts/pve-01/112-example/deployment.yaml',
          summary: 'Create deployment YAML',
          before: null,
          after: {
            id: 112,
            name: 'example',
            ssh: { password: new Secret('generated-secret') },
          },
        },
      ],
      warnings: ['Review generated networking before apply'],
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
    });

    expect(plan).toEqual(
      JSON.parse(await readFile(goldenPath, 'utf8')) as unknown,
    );
    expect(JSON.stringify(plan)).not.toContain('live-secret');
    expect(JSON.stringify(plan)).not.toContain('generated-secret');
    expect(parseMutationPlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
  });

  it('executes ordered changes, passes dryRun through, and rejects stale state', async () => {
    const plan = createMutationPlan({
      id: 'ordered',
      operation: 'fixture.apply',
      target: { hostId: 'pve-01' },
      summary: 'Apply fixture changes',
      currentState: { revision: 1 },
      changes: [
        { id: 'first', action: 'update', summary: 'First' },
        { id: 'second', action: 'execute', summary: 'Second' },
      ],
    });
    const order: string[] = [];
    const result = await executeMutationPlan({
      plan,
      dryRun: true,
      signal: new AbortController().signal,
      getCurrentState: async () => ({ revision: 1 }),
      executeChange: async (change, context) => {
        order.push(change.id);
        expect(context.dryRun).toBe(true);
        return { status: 'skipped', detail: { token: 'must-redact' } };
      },
    });
    expect(order).toEqual(['first', 'second']);
    expect(result).toMatchObject({ planId: 'ordered', dryRun: true });

    await expect(
      executeMutationPlan({
        plan,
        dryRun: false,
        signal: new AbortController().signal,
        getCurrentState: async () => ({ revision: 2 }),
        executeChange: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(StalePlanError);
  });

  it('fingerprints keys deterministically and validates unsafe plan shapes', async () => {
    expect(fingerprintPlanState({ b: 2, a: 1 })).toBe(
      fingerprintPlanState({ a: 1, b: 2 }),
    );
    expect(fingerprintPlanState(new Secret('a-secret'))).not.toBe(
      fingerprintPlanState(new Secret('different-secret')),
    );
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => fingerprintPlanState(cyclic)).toThrow(PlanValidationError);
    expect(() =>
      createMutationPlan({
        id: 'bad',
        operation: 'fixture',
        target: { hostId: 'pve-01' },
        summary: 'Bad destructive plan',
        currentState: {},
        changes: [
          {
            id: 'delete',
            action: 'delete',
            summary: 'Delete',
            destructive: true,
          },
        ],
      }),
    ).toThrow('typed confirmation');

    const controller = new AbortController();
    controller.abort('cancelled');
    const plan = createMutationPlan({
      id: 'cancelled',
      operation: 'fixture',
      target: { hostId: 'pve-01' },
      summary: 'Cancelled',
      currentState: {},
      changes: [{ id: 'one', action: 'update', summary: 'One' }],
    });
    await expect(
      executeMutationPlan({
        plan,
        dryRun: false,
        signal: controller.signal,
        getCurrentState: async () => ({}),
        executeChange: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(PlanCancelledError);
  });

  it('canonicalizes supported state values and rejects unsupported values', () => {
    expect(fingerprintPlanState(new Date('2026-01-01T00:00:00.000Z'))).toBe(
      fingerprintPlanState(new Date('2026-01-01T00:00:00.000Z')),
    );
    expect(fingerprintPlanState([1, undefined, 3n])).toBe(
      fingerprintPlanState([1, undefined, 3n]),
    );
    expect(fingerprintPlanState(undefined)).not.toBe(
      fingerprintPlanState(null),
    );
    for (const invalid of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Symbol('x'),
      () => 1,
    ]) {
      expect(() => fingerprintPlanState(invalid)).toThrow(PlanValidationError);
    }
  });

  it('validates every required plan field and confirmation secrecy', () => {
    const base = {
      id: 'valid',
      operation: 'fixture',
      target: { hostId: 'pve-01' },
      summary: 'Fixture plan',
      currentState: {},
      changes: [{ id: 'change', action: 'update' as const, summary: 'Change' }],
    };
    const invalidInputs = [
      { ...base, id: ' ' },
      { ...base, operation: ' ' },
      { ...base, target: { hostId: ' ' } },
      { ...base, summary: ' ' },
      { ...base, changes: [] },
      { ...base, changes: [{ ...base.changes[0]!, id: ' ' }] },
      {
        ...base,
        changes: [base.changes[0]!, { ...base.changes[0]! }],
      },
      { ...base, changes: [{ ...base.changes[0]!, summary: ' ' }] },
    ];
    for (const input of invalidInputs) {
      expect(() => createMutationPlan(input)).toThrow(PlanValidationError);
    }

    globalSecretRedactor.register('fixture-confirmation-secret');
    try {
      expect(() =>
        createMutationPlan({
          ...base,
          changes: [
            {
              ...base.changes[0]!,
              destructive: true,
              warnings: ['Review carefully'],
            },
          ],
          confirmationText: 'fixture-confirmation-secret',
        }),
      ).toThrow('must not contain a resolved secret');
    } finally {
      globalSecretRedactor.unregister('fixture-confirmation-secret');
    }

    const generatedTimestamp = createMutationPlan(base).createdAt;
    expect(Number.isNaN(Date.parse(generatedTimestamp))).toBe(false);
  });

  it('cancels between changes and supports results without detail', async () => {
    const controller = new AbortController();
    const plan = createMutationPlan({
      id: 'cancel-between',
      operation: 'fixture',
      target: { hostId: 'pve-01' },
      summary: 'Cancel between changes',
      currentState: {},
      changes: [
        { id: 'first', action: 'update', summary: 'First' },
        { id: 'second', action: 'update', summary: 'Second' },
      ],
    });
    await expect(
      executeMutationPlan({
        plan,
        dryRun: false,
        signal: controller.signal,
        getCurrentState: async () => ({}),
        executeChange: async () => {
          controller.abort('between changes');
          return { status: 'applied' };
        },
      }),
    ).rejects.toBeInstanceOf(PlanCancelledError);
  });
});

import { describe, expect, it } from 'vitest';
import { StalePlanError } from '@hacm/core';
import {
  GuestConfigurationError,
  GuestIdentityCheckError,
  GuestIdentityError,
  GuestNotFoundError,
  GuestProtectionEnabledError,
  GuestStateUnavailableError,
  GuestStoppedIdentityError,
  ProtectedGuestError,
} from '../guests/index.js';
import { planError } from './errors.js';
import {
  PlanAdminRequiredError,
  PlanConfirmationError,
  PlanNotFoundError,
  PlanOverwriteRequiredError,
  PlanStateError,
} from './types.js';

describe('planError', () => {
  it.each([
    [new PlanNotFoundError('plan-1'), 404, 'Not Found'],
    [
      new PlanOverwriteRequiredError('hosts/pve-01/112/deployment.yaml'),
      409,
      'Conflict',
    ],
    [new PlanAdminRequiredError(), 403, 'Forbidden'],
    [new PlanStateError('not ready'), 409, 'Conflict'],
    [new StalePlanError('plan-1', 'before', 'after'), 409, 'Conflict'],
    [new GuestNotFoundError('pve-01', 112), 404, 'Not Found'],
    [new ProtectedGuestError('pve-01', 112), 403, 'Forbidden'],
    [new GuestProtectionEnabledError('pve-01', 112), 409, 'Conflict'],
    [
      new GuestIdentityError({
        messages: ['identity mismatch'],
      } as never),
      409,
      'Conflict',
    ],
    [new GuestStoppedIdentityError('pve-01', 112), 409, 'Conflict'],
    [
      new GuestIdentityCheckError({
        check: 'hostname',
        ok: false,
        exitCode: 1,
        stderr: 'mismatch',
      }),
      409,
      'Conflict',
    ],
    [new GuestConfigurationError('invalid YAML'), 400, 'Bad Request'],
    [new GuestStateUnavailableError('pve-01', 'unreachable'), 409, 'Conflict'],
  ])('maps %s', (error, code, label) => {
    expect(planError(error)).toMatchObject({
      code,
      error: label,
      message: error.message,
    });
  });

  it('returns the typed confirmation text and ignores unknown errors', () => {
    expect(planError(new PlanConfirmationError('UPDATE pve-01/112'))).toEqual({
      code: 400,
      error: 'Bad Request',
      message: "Typed confirmation must exactly match 'UPDATE pve-01/112'",
      confirmationText: 'UPDATE pve-01/112',
    });
    expect(planError(new Error('unexpected'))).toBeNull();
  });
});

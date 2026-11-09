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
import {
  PlanConfirmationError,
  PlanAdminRequiredError,
  PlanNotFoundError,
  PlanOverwriteRequiredError,
  PlanStateError,
} from './types.js';

export function planError(error: unknown): {
  code: 400 | 403 | 404 | 409;
  error: string;
  message: string;
  confirmationText?: string;
} | null {
  if (error instanceof PlanNotFoundError) {
    return { code: 404, error: 'Not Found', message: error.message };
  }
  if (error instanceof PlanConfirmationError) {
    return {
      code: 400,
      error: 'Bad Request',
      message: error.message,
      confirmationText: error.expectedText,
    };
  }
  if (error instanceof PlanOverwriteRequiredError) {
    return { code: 409, error: 'Conflict', message: error.message };
  }
  if (error instanceof PlanAdminRequiredError) {
    return { code: 403, error: 'Forbidden', message: error.message };
  }
  if (error instanceof StalePlanError || error instanceof PlanStateError) {
    return { code: 409, error: 'Conflict', message: error.message };
  }
  if (error instanceof GuestNotFoundError) {
    return { code: 404, error: 'Not Found', message: error.message };
  }
  if (error instanceof ProtectedGuestError) {
    return { code: 403, error: 'Forbidden', message: error.message };
  }
  if (
    error instanceof GuestProtectionEnabledError ||
    error instanceof GuestIdentityError ||
    error instanceof GuestStoppedIdentityError ||
    error instanceof GuestIdentityCheckError
  ) {
    return { code: 409, error: 'Conflict', message: error.message };
  }
  if (error instanceof GuestConfigurationError) {
    return { code: 400, error: 'Bad Request', message: error.message };
  }
  if (error instanceof GuestStateUnavailableError) {
    return { code: 409, error: 'Conflict', message: error.message };
  }
  return null;
}

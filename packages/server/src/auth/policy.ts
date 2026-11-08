import type { AuthenticatedUser } from '../auth/session.js';
import type { DatabaseRepositories } from '../db/repositories/types.js';

export type UserRole = 'admin' | 'operator' | 'viewer';

export type PermissionAction =
  | 'edit_tasks'
  | 'edit_cmd'
  | 'edit_include'
  | 'edit_installation_url'
  | 'manage_users'
  | 'run_jobs'
  | 'read_resource';

export interface AuthorizeOptions {
  readonly action: PermissionAction;
  readonly hostId?: string | undefined;
}

/**
 * Central policy authorization check according to ADR 0008:
 * - Admin: Full access to everything across all hosts
 * - Operator: Can run jobs and read resources on granted hosts; CANNOT edit tasks, !cmd, !include, installation.url, or manage users
 * - Viewer: Read-only access on granted hosts; CANNOT run jobs or mutate
 */
export async function checkPermission(
  user: AuthenticatedUser,
  options: AuthorizeOptions,
  repos?: DatabaseRepositories,
): Promise<{ allowed: boolean; reason?: string }> {
  const role = user.role as UserRole;

  // Admin has unrestricted access everywhere
  if (role === 'admin') {
    return { allowed: true };
  }

  // Admin-only actions: edit tasks, !cmd, !include, installation.url, manage users
  const adminOnlyActions: PermissionAction[] = [
    'edit_tasks',
    'edit_cmd',
    'edit_include',
    'edit_installation_url',
    'manage_users',
  ];

  if (adminOnlyActions.includes(options.action)) {
    return {
      allowed: false,
      reason: `Action '${options.action}' is restricted to administrators only.`,
    };
  }

  // Check host access if a specific host is targeted
  if (options.hostId && repos) {
    const hasHostAccess = await repos.userHostAccess.hasAccess(
      user.id,
      options.hostId,
    );
    if (!hasHostAccess) {
      return {
        allowed: false,
        reason: `Access to host '${options.hostId}' has not been granted to this user.`,
      };
    }
  }

  // Operator can run jobs and read resources (on granted hosts)
  if (role === 'operator') {
    if (options.action === 'run_jobs' || options.action === 'read_resource') {
      return { allowed: true };
    }
  }

  // Viewer can only read resources (on granted hosts)
  if (role === 'viewer') {
    if (options.action === 'read_resource') {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `Viewers have read-only access and cannot perform action '${options.action}'.`,
    };
  }

  return {
    allowed: false,
    reason: `Unknown role or unauthorized action.`,
  };
}

import { describe, expect, it } from 'vitest';
import { checkPermission, type PermissionAction } from './policy.js';
import { createDatabase, createSqliteRepositories } from '../db/index.js';

describe('Central Permission Policy Matrix (ADR 0008)', () => {
  it('grants full access to admin across all actions and hosts', async () => {
    const handle = createDatabase({ path: ':memory:' });
    try {
      const repos = createSqliteRepositories(handle.db);
      const admin = {
        id: 'admin-1',
        username: 'admin',
        role: 'admin',
        autoGrantNewHosts: true,
      };

      const actions: PermissionAction[] = [
        'edit_tasks',
        'edit_cmd',
        'edit_include',
        'edit_installation_url',
        'manage_users',
        'run_jobs',
        'read_resource',
      ];

      for (const action of actions) {
        const result = await checkPermission(
          admin,
          { action, hostId: 'any-host' },
          repos,
        );
        expect(result.allowed).toBe(true);
      }
    } finally {
      handle.close();
    }
  });

  it('prevents operator from editing admin-only tasks, cmd, include, installation.url, and managing users', async () => {
    const handle = createDatabase({ path: ':memory:' });
    try {
      const repos = createSqliteRepositories(handle.db);
      const operator = {
        id: 'op-1',
        username: 'operator',
        role: 'operator',
        autoGrantNewHosts: false,
      };

      const adminOnly: PermissionAction[] = [
        'edit_tasks',
        'edit_cmd',
        'edit_include',
        'edit_installation_url',
        'manage_users',
      ];

      for (const action of adminOnly) {
        const result = await checkPermission(
          operator,
          { action, hostId: 'pve-01' },
          repos,
        );
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('restricted to administrators only');
      }
    } finally {
      handle.close();
    }
  });

  it('allows operator to run jobs and read resources only on granted hosts', async () => {
    const handle = createDatabase({ path: ':memory:' });
    try {
      const repos = createSqliteRepositories(handle.db);
      const operator = {
        id: 'op-1',
        username: 'operator',
        role: 'operator',
        autoGrantNewHosts: false,
      };

      // Create operator user
      await repos.users.create({
        id: operator.id,
        username: operator.username,
        passwordHash: 'hash',
        role: 'operator',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Grant access to pve-01 but not pve-02
      await repos.userHostAccess.grant(operator.id, 'pve-01');

      // Allowed on pve-01
      const jobOnPve01 = await checkPermission(
        operator,
        { action: 'run_jobs', hostId: 'pve-01' },
        repos,
      );
      expect(jobOnPve01.allowed).toBe(true);

      const readOnPve01 = await checkPermission(
        operator,
        { action: 'read_resource', hostId: 'pve-01' },
        repos,
      );
      expect(readOnPve01.allowed).toBe(true);

      // Denied on pve-02 (not granted)
      const jobOnPve02 = await checkPermission(
        operator,
        { action: 'run_jobs', hostId: 'pve-02' },
        repos,
      );
      expect(jobOnPve02.allowed).toBe(false);
      expect(jobOnPve02.reason).toContain('Access to host');
    } finally {
      handle.close();
    }
  });

  it('allows viewer read-only access on granted hosts and denies job running', async () => {
    const handle = createDatabase({ path: ':memory:' });
    try {
      const repos = createSqliteRepositories(handle.db);
      const viewer = {
        id: 'view-1',
        username: 'viewer',
        role: 'viewer',
        autoGrantNewHosts: false,
      };

      await repos.users.create({
        id: viewer.id,
        username: viewer.username,
        passwordHash: 'hash',
        role: 'viewer',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await repos.userHostAccess.grant(viewer.id, 'pve-01');

      // Read allowed on granted host
      const readResult = await checkPermission(
        viewer,
        { action: 'read_resource', hostId: 'pve-01' },
        repos,
      );
      expect(readResult.allowed).toBe(true);

      // Run jobs DENIED for viewer
      const jobResult = await checkPermission(
        viewer,
        { action: 'run_jobs', hostId: 'pve-01' },
        repos,
      );
      expect(jobResult.allowed).toBe(false);
      expect(jobResult.reason).toContain('Viewers have read-only access');

      // Edit tasks DENIED for viewer
      const taskResult = await checkPermission(
        viewer,
        { action: 'edit_tasks', hostId: 'pve-01' },
        repos,
      );
      expect(taskResult.allowed).toBe(false);
    } finally {
      handle.close();
    }
  });

  it('auto-grants new hosts to eligible users when flag is set', async () => {
    const handle = createDatabase({ path: ':memory:' });
    try {
      const repos = createSqliteRepositories(handle.db);

      const user1 = await repos.users.create({
        id: 'u-1',
        username: 'auto_grant_user',
        passwordHash: 'hash',
        role: 'operator',
        autoGrantNewHosts: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const user2 = await repos.users.create({
        id: 'u-2',
        username: 'manual_user',
        passwordHash: 'hash',
        role: 'operator',
        autoGrantNewHosts: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Auto-grant when new host 'pve-cluster-01' is detected
      const count =
        await repos.userHostAccess.autoGrantHostToEligibleUsers(
          'pve-cluster-01',
        );
      expect(count).toBe(1);

      expect(
        await repos.userHostAccess.hasAccess(user1.id, 'pve-cluster-01'),
      ).toBe(true);
      expect(
        await repos.userHostAccess.hasAccess(user2.id, 'pve-cluster-01'),
      ).toBe(false);
    } finally {
      handle.close();
    }
  });
});

import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import {
  createDatabase,
  runMigrations,
  createSqliteRepositories,
} from './index.js';

describe('Database foundation', () => {
  it('creates an in-memory database with tables and WAL pragma', () => {
    const handle = createDatabase({ path: ':memory:' });
    try {
      // WAL on in-memory defaults to memory mode; test foreign_keys
      const fk = handle.sqlite.pragma('foreign_keys', { simple: true });
      expect(fk).toBe(1);

      // Verify migration tracking table exists
      const tables = handle.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as { name: string }[];
      const names = tables.map((t) => t.name);
      expect(names).toContain('__hacm_migrations');
      expect(names).toContain('settings');
      expect(names).toContain('hosts');
      expect(names).toContain('sessions');
    } finally {
      handle.close();
    }
  });

  it('is idempotent when running migrations multiple times', () => {
    const handle = createDatabase({ path: ':memory:' });
    try {
      const secondRun = runMigrations(handle.sqlite);
      expect(secondRun).toHaveLength(0);
    } finally {
      handle.close();
    }
  });

  it('supports SettingsRepository operations', async () => {
    const handle = createDatabase({ path: ':memory:' });
    try {
      const repos = createSqliteRepositories(handle.db);

      expect(await repos.settings.get('non_existent')).toBeNull();

      await repos.settings.set('theme', 'dark');
      expect(await repos.settings.get('theme')).toBe('dark');

      // Update existing
      await repos.settings.set('theme', 'light');
      expect(await repos.settings.get('theme')).toBe('light');

      const all = await repos.settings.list();
      expect(all).toHaveLength(1);
      expect(all[0]?.key).toBe('theme');

      const deleted = await repos.settings.delete('theme');
      expect(deleted).toBe(true);
      expect(await repos.settings.get('theme')).toBeNull();
      expect(await repos.settings.delete('theme')).toBe(false);
    } finally {
      handle.close();
    }
  });

  it('supports HostsCacheRepository operations', async () => {
    const handle = createDatabase({ path: ':memory:' });
    try {
      const repos = createSqliteRepositories(handle.db);

      expect(await repos.hostsCache.get('pve-01')).toBeNull();

      const now = new Date();
      await repos.hostsCache.upsert({
        id: 'pve-01',
        name: 'Proxmox 01',
        type: 'proxmox',
        status: 'online',
        lastSeenAt: now,
        cachedConfigJson: '{"id":"pve-01"}',
        updatedAt: now,
      });

      const retrieved = await repos.hostsCache.get('pve-01');
      expect(retrieved).not.toBeNull();
      expect(retrieved?.name).toBe('Proxmox 01');
      expect(retrieved?.status).toBe('online');

      // Update host cache
      await repos.hostsCache.upsert({
        id: 'pve-01',
        name: 'Proxmox Primary',
        type: 'proxmox',
        status: 'degraded',
        cachedConfigJson: '{"id":"pve-01","updated":true}',
        updatedAt: new Date(),
      });

      const updated = await repos.hostsCache.get('pve-01');
      expect(updated?.name).toBe('Proxmox Primary');
      expect(updated?.status).toBe('degraded');

      const list = await repos.hostsCache.list();
      expect(list).toHaveLength(1);

      const deleted = await repos.hostsCache.delete('pve-01');
      expect(deleted).toBe(true);
      expect(await repos.hostsCache.get('pve-01')).toBeNull();
    } finally {
      handle.close();
    }
  });

  it('supports SessionsRepository operations and expiration cleanup', async () => {
    const handle = createDatabase({ path: ':memory:' });
    try {
      const repos = createSqliteRepositories(handle.db);

      const now = new Date();
      const past = new Date(now.getTime() - 10000);
      const future = new Date(now.getTime() + 60000);

      // Create users first to satisfy foreign key constraints
      await repos.users.create({
        id: 'admin-1',
        username: 'admin1',
        passwordHash: 'hash1',
        role: 'admin',
        createdAt: now,
        updatedAt: now,
      });

      await repos.users.create({
        id: 'user-2',
        username: 'user2',
        passwordHash: 'hash2',
        role: 'viewer',
        createdAt: now,
        updatedAt: now,
      });

      await repos.sessions.create({
        id: 'sess-active',
        userId: 'admin-1',
        expiresAt: future,
        createdAt: now,
        lastSeenAt: now,
        ipAddress: '127.0.0.1',
        userAgent: 'test-agent',
      });

      await repos.sessions.create({
        id: 'sess-expired',
        userId: 'admin-1',
        expiresAt: past,
        createdAt: past,
        lastSeenAt: past,
      });

      await repos.sessions.create({
        id: 'sess-user-2',
        userId: 'user-2',
        expiresAt: future,
        createdAt: now,
        lastSeenAt: now,
      });

      const active = await repos.sessions.get('sess-active');
      expect(active).not.toBeNull();
      expect(active?.userId).toBe('admin-1');

      // Update last seen
      const seenNow = new Date();
      await repos.sessions.updateLastSeen('sess-active', seenNow);
      const updatedActive = await repos.sessions.get('sess-active');
      expect(updatedActive?.lastSeenAt.getTime()).toBe(seenNow.getTime());

      // Cleanup expired
      const deletedCount = await repos.sessions.deleteExpired(now);
      expect(deletedCount).toBe(1);
      expect(await repos.sessions.get('sess-expired')).toBeNull();
      expect(await repos.sessions.get('sess-active')).not.toBeNull();

      // Delete by user
      const deletedUserCount = await repos.sessions.deleteByUserId('admin-1');
      expect(deletedUserCount).toBe(1);
      expect(await repos.sessions.get('sess-active')).toBeNull();
      expect(await repos.sessions.get('sess-user-2')).not.toBeNull();

      // Delete single session
      expect(await repos.sessions.delete('sess-user-2')).toBe(true);
      expect(await repos.sessions.delete('non-existent')).toBe(false);
    } finally {
      handle.close();
    }
  });

  it('creates disk database file and sets WAL mode', () => {
    const dbPath = resolve(import.meta.dirname, '../../dist/test-db.sqlite');
    if (existsSync(dbPath)) {
      rmSync(dbPath, { force: true });
    }

    try {
      const handle = createDatabase({ path: dbPath });
      try {
        const journal = handle.sqlite.pragma('journal_mode', { simple: true });
        expect(journal).toBe('wal');
      } finally {
        handle.close();
      }
    } finally {
      if (existsSync(dbPath)) {
        rmSync(dbPath, { force: true });
      }
      const wal = `${dbPath}-wal`;
      const shm = `${dbPath}-shm`;
      if (existsSync(wal)) rmSync(wal, { force: true });
      if (existsSync(shm)) rmSync(shm, { force: true });
    }
  });
});

import { describe, expect, it } from 'vitest';
import { createDatabase } from './connection.js';
import { createSqliteRepositories } from './repositories/sqlite.js';
import type { InsertDriftSnapshotRow } from './schema.js';

function snapshot(
  overrides: Partial<InsertDriftSnapshotRow> = {},
): InsertDriftSnapshotRow {
  return {
    id: 'snapshot-1',
    hostId: 'pve-01',
    vmid: 112,
    guestType: 'lxc',
    status: 'drifted',
    changesJson: '[]',
    computedFieldsJson: '[]',
    ignoredPathsJson: '[]',
    checkedAt: new Date('2026-11-09T10:00:00.000Z'),
    updatedAt: new Date('2026-11-09T10:00:00.000Z'),
    ...overrides,
  };
}

describe('drift snapshots repository', () => {
  it('upserts, reads, lists and deletes snapshots', async () => {
    const handle = createDatabase({ path: ':memory:' });
    try {
      const repos = createSqliteRepositories(handle.db);

      const inserted = await repos.driftSnapshots.upsert(snapshot());
      expect(inserted).toMatchObject({
        id: 'snapshot-1',
        hostId: 'pve-01',
        vmid: 112,
        guestType: 'lxc',
        status: 'drifted',
      });

      const updated = await repos.driftSnapshots.upsert(
        snapshot({
          id: 'snapshot-replacement',
          status: 'in_sync',
          changesJson: '[]',
          computedFieldsJson: '["ram"]',
          checkedAt: new Date('2026-11-09T11:00:00.000Z'),
          updatedAt: new Date('2026-11-09T11:00:00.000Z'),
        }),
      );
      expect(updated.id).toBe('snapshot-1');
      expect(updated.status).toBe('in_sync');
      expect(updated.computedFieldsJson).toBe('["ram"]');
      expect(updated.checkedAt.toISOString()).toBe('2026-11-09T11:00:00.000Z');

      await repos.driftSnapshots.upsert(
        snapshot({
          id: 'snapshot-2',
          hostId: 'pve-02',
          vmid: 212,
          guestType: 'vm',
          status: 'in_sync',
          checkedAt: new Date('2026-11-09T09:00:00.000Z'),
        }),
      );

      expect(await repos.driftSnapshots.get('pve-01', 112)).toMatchObject({
        id: 'snapshot-1',
      });
      expect(await repos.driftSnapshots.get('pve-01', 999)).toBeNull();

      expect(await repos.driftSnapshots.list()).toHaveLength(2);
      expect(
        await repos.driftSnapshots.list({ hostId: 'pve-01' }),
      ).toHaveLength(1);
      expect(await repos.driftSnapshots.list({ vmid: 212 })).toHaveLength(1);
      expect(
        await repos.driftSnapshots.list({ statuses: ['in_sync'] }),
      ).toHaveLength(2);
      expect(await repos.driftSnapshots.list({ statuses: [] })).toHaveLength(2);
      expect(await repos.driftSnapshots.list({ limit: 1 })).toHaveLength(1);

      expect(await repos.driftSnapshots.delete('pve-01', 112)).toBe(true);
      expect(await repos.driftSnapshots.delete('pve-01', 112)).toBe(false);
      expect(await repos.driftSnapshots.get('pve-01', 112)).toBeNull();
    } finally {
      handle.close();
    }
  });
});

import { describe, expect, it } from 'vitest';
import {
  assessGuestIdentity,
  isManagedGuestTag,
  liveIdentityFromDeployment,
  MANAGED_GUEST_TAG,
  managedGuestUuid,
  parseManagedGuestUuid,
  stampManagedIdentity,
  stripManagedIdentity,
} from './identity.js';
import type { GuestDeployment } from '../schema/deployment.js';

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function lxc(overrides: Partial<GuestDeployment> = {}): GuestDeployment {
  return {
    id: 112,
    name: 'example-lxc',
    type: 'lxc',
    cpu: 2,
    ram: 1024,
    disks: [],
    network: [],
    ...overrides,
  } as GuestDeployment;
}

describe('managed guest identity', () => {
  it('derives a stable, version 5 UUID from host and VMID', () => {
    const first = managedGuestUuid('pve-01', 112);
    expect(first).toBe(managedGuestUuid('pve-01', 112));
    expect(first).toMatch(uuidPattern);
    expect(first).not.toBe(managedGuestUuid('pve-01', 113));
    expect(first).not.toBe(managedGuestUuid('pve-02', 112));
    expect(() => managedGuestUuid('', 112)).toThrow('hostId is required');
    expect(() => managedGuestUuid('pve-01', 0)).toThrow(
      'vmid must be a positive integer',
    );
    expect(() => managedGuestUuid('pve-01', 1.5)).toThrow(
      'vmid must be a positive integer',
    );
  });

  it('stamps tags and descriptions without losing user content', () => {
    const uuid = managedGuestUuid('pve-01', 112);
    const first = stampManagedIdentity(
      { tags: ['app', 'public'], description: 'Owner: alice' },
      uuid,
    );
    expect(first.changed).toBe(true);
    expect(first.tags).toEqual(['app', 'public', MANAGED_GUEST_TAG]);
    expect(first.description).toBe(`Owner: alice\nhacm-managed: ${uuid}`);
    expect(parseManagedGuestUuid(first.description)).toBe(uuid);

    const again = stampManagedIdentity(first, uuid);
    expect(again.changed).toBe(false);
    expect(again.description).toBe(first.description);

    const replaced = stampManagedIdentity(
      { tags: first.tags, description: first.description },
      managedGuestUuid('pve-02', 112),
    );
    expect(replaced.description).toContain(
      `hacm-managed: ${managedGuestUuid('pve-02', 112)}`,
    );
    expect(replaced.description.match(/hacm-managed:/g)).toHaveLength(1);

    const inserted = stampManagedIdentity(
      { description: `Title\nhacm-managed: ${uuid}\nFooter` },
      uuid,
    );
    expect(inserted.description).toBe(`Title\nhacm-managed: ${uuid}\nFooter`);
    expect(() => stampManagedIdentity({}, 'not-a-uuid')).toThrow(
      'Managed guest UUID is malformed',
    );

    const minimal = stampManagedIdentity({}, uuid);
    expect(minimal.description).toBe(`hacm-managed: ${uuid}`);
    expect(minimal.tags).toEqual([MANAGED_GUEST_TAG]);
    const withTrailingNewline = stampManagedIdentity(
      { tags: [], description: 'Owner: alice\n' },
      uuid,
    );
    expect(withTrailingNewline.description).toBe(
      `Owner: alice\nhacm-managed: ${uuid}`,
    );
    const leadingStamp = stampManagedIdentity(
      { description: `hacm-managed: ${managedGuestUuid('pve-02', 112)}` },
      uuid,
    );
    expect(leadingStamp.description).toBe(`hacm-managed: ${uuid}`);
  });

  it('strips the managed tag and stamp while preserving user data', () => {
    const uuid = managedGuestUuid('pve-01', 112);
    const stripped = stripManagedIdentity({
      tags: ['app', MANAGED_GUEST_TAG],
      description: `Owner: alice\nhacm-managed: ${uuid}\n`,
    });
    expect(stripped.tags).toEqual(['app']);
    expect(stripped.description).toBe('Owner: alice');
    expect(stripped.changed).toBe(true);
    expect(stripManagedIdentity({ tags: [], description: '' }).changed).toBe(
      false,
    );
    expect(stripManagedIdentity({})).toEqual({
      tags: [],
      description: '',
      changed: false,
    });
    expect(
      stripManagedIdentity({
        description: `Owner\nhacm-managed: ${uuid}\nFooter`,
      }).description,
    ).toBe('Owner\nFooter');
    expect(
      stripManagedIdentity({
        description: `hacm-managed: ${uuid}`,
      }).description,
    ).toBe('');
    expect(isManagedGuestTag([MANAGED_GUEST_TAG])).toBe(true);
    expect(isManagedGuestTag(undefined)).toBe(false);
    expect(parseManagedGuestUuid(undefined)).toBeUndefined();
    expect(parseManagedGuestUuid('nothing here')).toBeUndefined();
  });

  it('detects name, type, stamp and missing-stamp collisions', () => {
    const uuid = managedGuestUuid('pve-01', 112);
    const expected = {
      hostId: 'pve-01',
      vmid: 112,
      name: 'example-lxc',
      type: 'lxc' as const,
    };

    expect(
      assessGuestIdentity(expected, { exists: false, vmid: 112 }),
    ).toMatchObject({ status: 'missing', ok: false });
    expect(
      assessGuestIdentity(expected, {
        exists: true,
        vmid: 112,
        name: 'example-lxc',
        type: 'vm',
      }),
    ).toMatchObject({ status: 'type-mismatch', ok: false });
    expect(
      assessGuestIdentity(expected, {
        exists: true,
        vmid: 112,
        name: 'example-lxc',
        type: undefined,
      }),
    ).toMatchObject({ status: 'unmanaged', ok: false });
    expect(
      assessGuestIdentity(expected, {
        exists: true,
        vmid: 112,
        name: 'example-lxc',
        type: 'vm',
        description: `hacm-managed: ${uuid}`,
      }),
    ).toMatchObject({
      status: 'type-mismatch',
      actualUuid: uuid,
    });
    expect(
      assessGuestIdentity(expected, {
        exists: true,
        vmid: 112,
        name: 'other-workload',
        type: 'lxc',
      }),
    ).toMatchObject({ status: 'name-mismatch', ok: false });
    expect(
      assessGuestIdentity(expected, {
        exists: true,
        vmid: 112,
        name: 'other-workload',
        type: 'lxc',
        description: `hacm-managed: ${uuid}`,
      }),
    ).toMatchObject({
      status: 'name-mismatch',
      actualUuid: uuid,
    });
    expect(
      assessGuestIdentity(expected, {
        exists: true,
        vmid: 112,
        name: 'example-lxc',
        type: 'lxc',
        tags: [MANAGED_GUEST_TAG],
        description: `hacm-managed: ${managedGuestUuid('pve-02', 112)}`,
      }),
    ).toMatchObject({ status: 'stamp-mismatch', ok: false });
    expect(
      assessGuestIdentity(expected, {
        exists: true,
        vmid: 112,
        name: 'example-lxc',
        type: 'lxc',
        tags: ['app'],
        description: 'Owner: alice',
      }),
    ).toMatchObject({ status: 'unmanaged', ok: false });
    expect(
      assessGuestIdentity(expected, {
        exists: true,
        vmid: 112,
        name: 'example-lxc',
        type: 'lxc',
        tags: ['app'],
        description: `hacm-managed: ${uuid}`,
      }),
    ).toMatchObject({ status: 'unmanaged', actualUuid: uuid });
    expect(
      assessGuestIdentity(expected, {
        exists: true,
        vmid: 112,
        name: 'example-lxc',
        type: 'lxc',
        tags: [MANAGED_GUEST_TAG],
        description: `hacm-managed: ${uuid}`,
      }),
    ).toEqual({
      status: 'verified',
      ok: true,
      expectedUuid: uuid,
      actualUuid: uuid,
      messages: [],
    });
  });

  it('maps canonical deployments to live identity fields', () => {
    const uuid = managedGuestUuid('pve-01', 112);
    const identity = liveIdentityFromDeployment(
      lxc({
        tags: [MANAGED_GUEST_TAG],
        extra: { description: `hacm-managed: ${uuid}` },
      }),
      { exists: true, status: 'running' },
    );
    expect(identity).toEqual({
      exists: true,
      vmid: 112,
      name: 'example-lxc',
      type: 'lxc',
      status: 'running',
      tags: [MANAGED_GUEST_TAG],
      description: `hacm-managed: ${uuid}`,
    });
    expect(
      liveIdentityFromDeployment(lxc({ extra: { description: 42 } }), {
        exists: true,
      }),
    ).toMatchObject({ description: undefined });
  });
});

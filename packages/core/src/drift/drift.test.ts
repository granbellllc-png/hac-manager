import { describe, expect, it } from 'vitest';
import { DefaultProvenanceMap } from '../merge/provenance-map.js';
import type { GuestDeployment } from '../schema/deployment.js';
import { Secret } from '../tags/secret.js';
import { computeGuestDrift } from './drift.js';

function lxc(
  overrides: Partial<Extract<GuestDeployment, { type: 'lxc' }>> = {},
): GuestDeployment {
  return {
    schema_version: 1,
    id: 112,
    name: 'adguard',
    type: 'lxc',
    cpu: 2,
    ram: 2048,
    disks: [],
    network: [],
    ...overrides,
  };
}

function vm(
  overrides: Partial<Extract<GuestDeployment, { type: 'vm' }>> = {},
): GuestDeployment {
  return {
    schema_version: 1,
    id: 212,
    name: 'homeassistant',
    type: 'vm',
    cpu: 2,
    ram: 4096,
    disks: [],
    network: [],
    ...overrides,
  };
}

describe('computeGuestDrift', () => {
  it('reports a single RAM difference with provenance', () => {
    const provenance = new DefaultProvenanceMap();
    provenance.set({
      path: ['ram'],
      pathString: 'ram',
      layer: 'override',
      file: 'hosts/pve-01/112-adguard/deployment.yaml',
      sourcePath: ['ram'],
      isTag: false,
      value: 2048,
    });

    const result = computeGuestDrift({
      hostId: 'pve-01',
      vmid: 112,
      type: 'lxc',
      desired: lxc({ ram: 2048 }),
      live: lxc({ ram: 4096 }),
      provenance,
      checkedAt: new Date('2026-11-09T10:00:00.000Z'),
    });

    expect(result.status).toBe('drifted');
    expect(result.checkedAt).toBe('2026-11-09T10:00:00.000Z');
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      path: 'ram',
      category: 'config',
      kind: 'changed',
      desired: 2048,
      actual: 4096,
      pullable: true,
      computed: false,
      secret: false,
      provenance: {
        layer: 'override',
        file: 'hosts/pve-01/112-adguard/deployment.yaml',
        path: 'ram',
        sourcePath: 'ram',
      },
    });
  });

  it('reports no drift for equal configurations', () => {
    const result = computeGuestDrift({
      hostId: 'pve-01',
      vmid: 112,
      type: 'lxc',
      desired: lxc(),
      live: lxc(),
    });
    expect(result.status).toBe('in_sync');
    expect(result.changes).toEqual([]);
  });

  it('marks resolved tag fields as computed and never pullable', () => {
    const provenance = new DefaultProvenanceMap();
    provenance.set({
      path: ['cpu'],
      pathString: 'cpu',
      layer: 'override',
      file: 'guest.yaml',
      sourcePath: ['cpu'],
      isTag: true,
      tag: 'expr',
      value: { tag: 'expr', value: 'host.index + 1' },
    });

    const result = computeGuestDrift({
      hostId: 'pve-01',
      vmid: 112,
      type: 'lxc',
      desired: lxc({ cpu: 4 }),
      live: lxc({ cpu: 2 }),
      provenance,
    });

    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      path: 'cpu',
      desired: 4,
      actual: 2,
      computed: true,
      pullable: false,
      tag: 'expr',
    });
    expect(result.computedFields).toContain('cpu');
  });

  it('does not diff unresolved tag values but records them as computed', () => {
    const desired = lxc();
    desired.cpu = { tag: 'expr', value: 'host.index + 1' };

    const result = computeGuestDrift({
      hostId: 'pve-01',
      vmid: 112,
      type: 'lxc',
      desired,
      live: lxc({ cpu: 8 }),
      provenance: undefined,
    });

    expect(result.status).toBe('in_sync');
    expect(result.changes).toEqual([]);
    expect(result.computedFields).toEqual(['cpu']);
  });

  it('compares secret fields by hash and never exposes plaintext', () => {
    const desired = vm({
      cloud_init: { password: new Secret('fake-correct-horse') as never },
    });
    const live = vm({
      cloud_init: { password: 'fake-wrong-horse' },
    });

    const result = computeGuestDrift({
      hostId: 'pve-01',
      vmid: 212,
      type: 'vm',
      desired,
      live,
    });

    expect(result.changes).toHaveLength(1);
    const [change] = result.changes;
    expect(change).toMatchObject({
      path: 'cloud_init.password',
      category: 'cloud_init',
      secret: true,
      computed: false,
      pullable: false,
      desired: '***',
      actual: '***',
    });
    expect(change?.desiredHash).toMatch(/^[0-9a-f]{16}$/);
    expect(change?.actualHash).toMatch(/^[0-9a-f]{16}$/);
    expect(change?.desiredHash).not.toBe(change?.actualHash);
    expect(JSON.stringify(result)).not.toContain('horse');
  });

  it('does not report matching secrets', () => {
    const result = computeGuestDrift({
      hostId: 'pve-01',
      vmid: 212,
      type: 'vm',
      desired: vm({
        cloud_init: { password: new Secret('same-value') as never },
      }),
      live: vm({ cloud_init: { password: 'same-value' } }),
    });
    expect(result.changes).toEqual([]);
  });

  it('never offers pull for collections that contain secrets', () => {
    const result = computeGuestDrift({
      hostId: 'pve-01',
      vmid: 212,
      type: 'vm',
      desired: vm({
        cloud_init: {
          ssh_keys: [new Secret('fake-ssh-key') as never],
        },
      }),
      live: vm({
        cloud_init: { ssh_keys: ['ssh-ed25519 AAAA fake'] },
      }),
    });

    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      path: 'cloud_init.ssh_keys',
      secret: true,
      pullable: false,
    });
    expect(JSON.stringify(result)).not.toContain('fake-ssh-key');
  });

  it('marks collections containing tagged values as computed', () => {
    const provenance = new DefaultProvenanceMap();
    provenance.set({
      path: ['cloud_init', 'ssh_keys', 0],
      pathString: 'cloud_init.ssh_keys[0]',
      layer: 'override',
      file: 'guest.yaml',
      sourcePath: ['cloud_init', 'ssh_keys', 0],
      isTag: true,
      tag: 'env',
      value: ['SSH_PUBLIC_KEY'],
    });

    const result = computeGuestDrift({
      hostId: 'pve-01',
      vmid: 212,
      type: 'vm',
      desired: vm({
        cloud_init: {
          ssh_keys: [{ tag: 'env', value: 'SSH_PUBLIC_KEY' }],
        },
      }),
      live: vm({
        cloud_init: { ssh_keys: ['ssh-ed25519 AAAA fake'] },
      }),
      provenance,
    });

    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      path: 'cloud_init.ssh_keys',
      computed: true,
      pullable: false,
    });
    expect(result.computedFields).toContain('cloud_init.ssh_keys');
  });

  it('reports NIC and feature differences with structured paths', () => {
    const result = computeGuestDrift({
      hostId: 'pve-01',
      vmid: 112,
      type: 'lxc',
      desired: lxc({
        network: [
          { index: 0, name: 'eth0', bridge: 'vmbr0', ip: '192.0.2.10/24' },
        ],
        features: { nesting: true },
      }),
      live: lxc({
        network: [
          {
            index: 0,
            name: 'eth0',
            bridge: 'vmbr1',
            ip: '192.0.2.10/24',
            mac: 'A2:B1:C1:01:E0:12',
          },
        ],
        features: { nesting: false },
      }),
    });

    expect(result.changes.map((change) => change.path).sort()).toEqual([
      'features.nesting',
      'network[0].bridge',
    ]);
    expect(
      result.changes.every(
        (change) =>
          change.category === 'network' || change.category === 'feature',
      ),
    ).toBe(true);
  });

  it('detects added and removed NICs and mounts', () => {
    const result = computeGuestDrift({
      hostId: 'pve-01',
      vmid: 112,
      type: 'lxc',
      desired: lxc({
        network: [{ index: 0, bridge: 'vmbr0' }],
        mounts: [
          {
            index: 0,
            host_path: '/srv/data/112/opt',
            guest_path: '/opt',
            permissions: 'minimal',
          },
        ],
      }),
      live: lxc({
        network: [{ index: 1, bridge: 'vmbr1' }],
      }),
    });

    expect(result.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'network[0]',
          kind: 'missing_in_live',
        }),
        expect.objectContaining({
          path: 'network[1]',
          kind: 'missing_in_yaml',
        }),
        expect.objectContaining({
          path: 'mounts[0]',
          kind: 'missing_in_live',
          category: 'mount',
        }),
      ]),
    );
  });

  it('compares tags as an order-independent set and ignores the managed tag', () => {
    const result = computeGuestDrift({
      hostId: 'pve-01',
      vmid: 112,
      type: 'lxc',
      desired: lxc({ tags: ['web', 'edge'] }),
      live: lxc({ tags: ['edge', 'hacm-managed', 'web'] }),
    });
    expect(result.changes).toEqual([]);

    const changed = computeGuestDrift({
      hostId: 'pve-01',
      vmid: 112,
      type: 'lxc',
      desired: lxc({ tags: ['web'] }),
      live: lxc({ tags: ['web', 'db'] }),
    });
    expect(changed.changes).toHaveLength(1);
    expect(changed.changes[0]).toMatchObject({
      path: 'tags',
      category: 'tags',
      desired: ['web'],
      actual: ['db', 'web'],
    });
  });

  it('compares protection, LXC and VM-specific fields', () => {
    const lxcResult = computeGuestDrift({
      hostId: 'pve-01',
      vmid: 112,
      type: 'lxc',
      desired: lxc({
        protection: true,
        unprivileged: true,
        swap: 512,
        ostype: 'debian',
        onboot: true,
        startup: 'order=2,up=30',
      }),
      live: lxc({
        protection: false,
        unprivileged: false,
        swap: 0,
        ostype: 'alpine',
        onboot: false,
        startup: 'order=1',
      }),
    });
    expect(lxcResult.changes.map((change) => change.path)).toEqual([
      'protection',
      'unprivileged',
      'swap',
      'ostype',
      'onboot',
      'startup',
    ]);

    const vmResult = computeGuestDrift({
      hostId: 'pve-01',
      vmid: 212,
      type: 'vm',
      desired: vm({
        bios: 'ovmf',
        machine: 'q35',
        efi_disk: true,
        tpm: true,
        guest_agent: true,
      }),
      live: vm({
        bios: 'seabios',
        machine: 'pc',
        efi_disk: false,
        tpm: false,
        guest_agent: false,
      }),
    });
    expect(vmResult.changes.map((change) => change.path)).toEqual([
      'bios',
      'machine',
      'efi_disk',
      'tpm',
      'guest_agent',
    ]);
  });

  it('flags disk shrink as unsafe to enforce and reports growth', () => {
    const shrunk = computeGuestDrift({
      hostId: 'pve-01',
      vmid: 112,
      type: 'lxc',
      desired: lxc({
        disks: [{ name: 'rootfs', storage: 'local-lvm', size_gb: 8 }],
      }),
      live: lxc({
        disks: [{ name: 'rootfs', storage: 'local-lvm', size_gb: 16 }],
      }),
    });
    expect(shrunk.changes[0]).toMatchObject({
      path: 'disks[0].size_gb',
      category: 'disk',
      desired: 8,
      actual: 16,
    });
    expect(shrunk.changes[0]?.warnings?.[0]).toMatch(/only grow/i);

    const grown = computeGuestDrift({
      hostId: 'pve-01',
      vmid: 112,
      type: 'lxc',
      desired: lxc({
        disks: [{ name: 'rootfs', storage: 'local-lvm', size_gb: 32 }],
      }),
      live: lxc({
        disks: [{ name: 'rootfs', storage: 'local-lvm', size_gb: 16 }],
      }),
    });
    expect(grown.changes[0]?.warnings).toBeUndefined();
  });

  it('honours additional ignored paths and hides sensitive values recursively', () => {
    const result = computeGuestDrift({
      hostId: 'pve-01',
      vmid: 112,
      type: 'lxc',
      desired: lxc({
        ssh: { password: 'fake-desired-password' },
        network: [{ index: 0, bridge: 'vmbr0' }],
      }),
      live: lxc({
        network: [{ index: 0, bridge: 'vmbr1' }],
      }),
      ignoredPaths: ['network'],
    });
    expect(result.changes).toEqual([]);
    expect(result.ignoredPaths).toContain('network');
  });

  it('handles generic arrays and whole-object missing values', () => {
    const arrayResult = computeGuestDrift({
      hostId: 'pve-01',
      vmid: 212,
      type: 'vm',
      desired: vm({
        cloud_init: { ssh_keys: ['ssh-ed25519 AAAA fake'] },
      }),
      live: vm({
        cloud_init: { ssh_keys: ['ssh-ed25519 BBBB fake'] },
      }),
    });
    expect(arrayResult.changes[0]).toMatchObject({
      path: 'cloud_init.ssh_keys',
      category: 'cloud_init',
    });

    const missing = computeGuestDrift({
      hostId: 'pve-01',
      vmid: 212,
      type: 'vm',
      desired: vm({ machine: 'q35' }),
      live: vm(),
    });
    expect(missing.changes[0]).toMatchObject({
      path: 'machine',
      kind: 'missing_in_live',
      actual: null,
    });
  });

  it('accepts string timestamps', () => {
    const result = computeGuestDrift({
      hostId: 'pve-01',
      vmid: 112,
      type: 'lxc',
      desired: lxc(),
      live: lxc(),
      checkedAt: '2026-11-09T10:00:00.000Z',
    });
    expect(result.checkedAt).toBe('2026-11-09T10:00:00.000Z');
  });
});

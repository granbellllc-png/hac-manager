import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseProxmoxConfig,
  serialiseProxmoxConfig,
  detectProxmoxConfigType,
  parseSizeGb,
  formatSizeGb,
} from './index.js';

describe('Proxmox Config Codec (Issue #29)', () => {
  const fixturesDir = join(__dirname, '../../fixtures/proxmox');

  it('normalizes disk size units correctly', () => {
    expect(parseSizeGb('8G')).toBe(8);
    expect(parseSizeGb('8192M')).toBe(8);
    expect(parseSizeGb('1T')).toBe(1024);
    expect(formatSizeGb(8)).toBe('8G');
    expect(formatSizeGb(10.5)).toBe('10.50G');
  });

  it('detects guest type correctly', () => {
    expect(detectProxmoxConfigType('hostname: lxc1\ncores: 2\n')).toBe('lxc');
    expect(detectProxmoxConfigType('name: vm1\nbios: ovmf\n')).toBe('vm');
  });

  it('round-trips lxc-112-unprivileged.conf fixture with parse(serialise(x)) identity', () => {
    const raw = readFileSync(
      join(fixturesDir, 'lxc-112-unprivileged.conf'),
      'utf8',
    );
    const parsed1 = parseProxmoxConfig(raw, 'lxc', 112);
    if (parsed1.type !== 'lxc') throw new Error('Expected LXC');

    expect(parsed1.id).toBe(112);
    expect(parsed1.name).toBe('example-lxc');
    expect(parsed1.type).toBe('lxc');
    expect(parsed1.cpu).toBe(2);
    expect(parsed1.ram).toBe(1024);
    expect(parsed1.swap).toBe(512);
    expect(parsed1.unprivileged).toBe(true);
    expect(parsed1.ostype).toBe('debian');
    expect(parsed1.tags).toEqual(['example', 'managed']);
    expect(parsed1.features?.nesting).toBe(true);
    expect(parsed1.disks[0]?.storage).toBe('local-lvm');
    expect(parsed1.disks[0]?.size_gb).toBe(8);
    expect(parsed1.network[0]?.bridge).toBe('vmbr0');
    expect(parsed1.network[0]?.mac).toBe('BC:24:11:00:00:01');
    expect(parsed1.network[0]?.firewall).toBe(true);
    expect(parsed1.network[0]?.ip).toBe('dhcp');

    // Round-trip check: parse(serialise(x)) === x
    const serialised = serialiseProxmoxConfig(parsed1);
    const parsed2 = parseProxmoxConfig(serialised, 'lxc', 112);

    expect(parsed2).toEqual(parsed1);
  });

  it('round-trips lxc-113-privileged-multi-nic.conf with multi-NIC and static IPs', () => {
    const raw = readFileSync(
      join(fixturesDir, 'lxc-113-privileged-multi-nic.conf'),
      'utf8',
    );
    const parsed1 = parseProxmoxConfig(raw, 'lxc', 113);
    if (parsed1.type !== 'lxc') throw new Error('Expected LXC');

    expect(parsed1.unprivileged).toBe(false);
    expect(parsed1.network).toHaveLength(2);
    expect(parsed1.network[0]?.ip).toBe('192.0.2.50/24');
    expect(parsed1.network[0]?.gateway).toBe('192.0.2.1');
    expect(parsed1.network[1]?.bridge).toBe('vmbr1');

    const serialised = serialiseProxmoxConfig(parsed1);
    const parsed2 = parseProxmoxConfig(serialised, 'lxc', 113);

    expect(parsed2).toEqual(parsed1);
  });

  it('round-trips lxc-114-mp0.conf handling mp0 and [PENDING] sections', () => {
    const raw = readFileSync(join(fixturesDir, 'lxc-114-mp0.conf'), 'utf8');
    const parsed1 = parseProxmoxConfig(raw, 'lxc', 114);

    expect(parsed1.mounts).toHaveLength(1);
    expect(parsed1.mounts?.[0]?.index).toBe(0);
    expect(parsed1.mounts?.[0]?.host_path).toBe('/tank/appdata/example-mp0');
    expect(parsed1.mounts?.[0]?.guest_path).toBe('/opt/appdata');
    expect(parsed1.extra?.['_pending']).toBeDefined();

    const serialised = serialiseProxmoxConfig(parsed1);
    expect(serialised).toContain('[PENDING]');
    expect(serialised).toContain('backup=1');

    const parsed2 = parseProxmoxConfig(serialised, 'lxc', 114);
    expect(parsed2).toEqual(parsed1);
  });

  it('round-trips vm-212-cloudinit-efi.conf with cloud-init, EFI, and SCSI disks', () => {
    const raw = readFileSync(
      join(fixturesDir, 'vm-212-cloudinit-efi.conf'),
      'utf8',
    );
    const parsed1 = parseProxmoxConfig(raw, 'vm', 212);
    if (parsed1.type !== 'vm') throw new Error('Expected VM');

    expect(parsed1.type).toBe('vm');
    expect(parsed1.name).toBe('example-vm');
    expect(parsed1.bios).toBe('ovmf');
    expect(parsed1.machine).toBe('q35');
    expect(parsed1.guest_agent).toBe(true);
    expect(parsed1.efi_disk).toBe(true);
    expect(parsed1.cloud_init?.user).toBe('example');
    expect(parsed1.cloud_init?.ssh_keys?.[0]).toContain('ssh-ed25519');
    expect(parsed1.disks[0]?.name).toBe('scsi0');
    expect(parsed1.disks[0]?.size_gb).toBe(32);
    expect(parsed1.network[0]?.bridge).toBe('vmbr0');
    expect(parsed1.network[0]?.ip).toBe('dhcp');

    const serialised = serialiseProxmoxConfig(parsed1);
    const parsed2 = parseProxmoxConfig(serialised, 'vm', 212);

    expect(parsed2).toEqual(parsed1);
  });
});

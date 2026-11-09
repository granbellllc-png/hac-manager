import { describe, expect, it } from 'vitest';
import { parseProxmoxConfig, detectProxmoxConfigType } from './codec.js';
import { parseLxcProxmoxConfig, serialiseLxcProxmoxConfig } from './lxc.js';
import { parseVmProxmoxConfig, serialiseVmProxmoxConfig } from './vm.js';
import { parseRawProxmoxConfig, serialiseRawProxmoxConfig } from './raw.js';
import {
  formatOptionString,
  parseOptionString,
  parseSizeGb,
} from './options.js';

describe('Proxmox configuration variants', () => {
  it('preserves separate pending and repeated snapshot sections without treating comments as keys', () => {
    const raw = parseRawProxmoxConfig(
      '# fixture\r\ncores: 2\r\nignored\n[PENDING]\ncores: 4\n[before]\nmemory: 512\n[before]\ncores: 1\n[after]\ncores: 3\n',
    );
    expect(raw).toEqual({
      main: { cores: '2' },
      pending: { cores: '4' },
      snapshots: {
        before: { memory: '512', cores: '1' },
        after: { cores: '3' },
      },
    });
    expect(parseRawProxmoxConfig(serialiseRawProxmoxConfig(raw))).toEqual(raw);
    expect(
      serialiseRawProxmoxConfig({ main: {}, pending: {}, snapshots: {} }),
    ).toBe('\n');
  });

  it('normalizes positional and boolean options with deterministic ordering', () => {
    expect(parseOptionString(' storage:disk,ro, ,size=8G ')).toEqual({
      positional: 'storage:disk',
      options: { ro: '1', size: '8G' },
    });
    expect(parseOptionString('size=8G,ro')).toEqual({
      positional: undefined,
      options: { size: '8G', ro: '1' },
    });
    expect(formatOptionString()).toBe('');
    expect(
      formatOptionString(
        'disk',
        { z: 4, a: 2, hidden: undefined, blank: '', first: true, last: false },
        ['first', 'last'],
      ),
    ).toBe('disk,first=1,last=0,a=2,z=4');
    expect(formatOptionString(undefined, { b: '0', a: '1' })).toBe('a=1,b=0');
    expect(parseSizeGb()).toBe(0);
    expect(parseSizeGb('unknown')).toBe(0);
    expect(parseSizeGb('1048576K')).toBe(1);
    expect(parseSizeGb('3')).toBe(3);
  });

  it.each([
    ['rootfs: local:disk', 'lxc'],
    ['unprivileged: 1', 'lxc'],
    ['scsihw: virtio-scsi-single', 'vm'],
    ['efidisk0: local:disk', 'vm'],
    ['machine: q35', 'vm'],
    ['cipassword: fake-password', 'vm'],
    ['cores: 2', 'lxc'],
  ])('detects the format of %s', (text, kind) => {
    expect(detectProxmoxConfigType(text)).toBe(kind);
    expect(parseProxmoxConfig(text).type).toBe(kind);
  });

  it('supports a minimal LXC and rejects passing a VM to the LXC encoder', () => {
    const guest = parseLxcProxmoxConfig('');
    expect(guest).toMatchObject({
      id: 100,
      name: 'lxc-100',
      cpu: 1,
      ram: 512,
      disks: [],
      network: [],
    });
    expect(parseLxcProxmoxConfig(serialiseLxcProxmoxConfig(guest))).toEqual(
      guest,
    );
    expect(() => serialiseLxcProxmoxConfig(parseVmProxmoxConfig(''))).toThrow(
      'Expected LXC',
    );
  });

  it('supports LXC mount flags, IPv6, optional network fields, and snapshot metadata', () => {
    const text =
      'hostname: fixture-lxc\nunprivileged: true\nfeatures: nesting=1,keyctl=1,fuse=1,mount=nfs;cifs\nrootfs: disk,size=0\nmp0: /fixture,mp=/opt,readonly=1\nmp1: ro=1\nnet0: name=eth0,firewall=0,vlan=5,ip6=2001:db8::2/64,gw6=2001:db8::1,mtu=1400,custom=value\nnet1: \n[before]\ncores: 1\n';
    const guest = parseLxcProxmoxConfig(text, 123);
    expect(guest.mounts?.[0]).toMatchObject({
      readonly: true,
      host_path: '/fixture',
    });
    expect(guest.network[0]).toMatchObject({
      firewall: false,
      vlan: 5,
      mtu: 1400,
      gateway6: '2001:db8::1',
      extra: { custom: 'value' },
    });
    expect(guest.disks[0]).toMatchObject({ storage: 'local-lvm', size_gb: 8 });
    const serialized = serialiseLxcProxmoxConfig(guest);
    expect(serialized).toContain('fuse=1');
    expect(serialized).toContain('gw6=2001:db8::1');
    expect(serialized).toContain('[before]');
    expect(serialized).toContain('ro=1');
    expect(
      parseLxcProxmoxConfig('rootfs: size=8G').disks[0]?.extra,
    ).toBeUndefined();
  });

  it('serializes authored LXC defaults and tag-shaped scalars', () => {
    const guest = parseLxcProxmoxConfig('');
    if (guest.type !== 'lxc') throw new Error('fixture must be LXC');
    const text = serialiseLxcProxmoxConfig({
      ...guest,
      cpu: { tag: 'expr', value: '2' },
      ram: undefined as unknown as number,
      features: { nesting: false, mount: [] },
      tags: [],
      disks: [{ name: 'rootfs', storage: 'local', size_gb: 8 }],
    });
    expect(text).toContain('cores: 2');
    expect(text).toContain('rootfs: local:vm-100-disk-0,size=8G');
    expect(text).not.toContain('features:');
  });

  it('supports minimal VMs and rejects passing an LXC to the VM encoder', () => {
    const guest = parseVmProxmoxConfig('');
    expect(guest).toMatchObject({
      id: 200,
      name: 'vm-200',
      cpu: 1,
      ram: 1024,
      bios: 'seabios',
      disks: [],
      network: [],
    });
    expect(parseVmProxmoxConfig(serialiseVmProxmoxConfig(guest))).toEqual(
      guest,
    );
    expect(() => serialiseVmProxmoxConfig(parseLxcProxmoxConfig(''))).toThrow(
      'Expected VM',
    );
  });

  it('handles optional VM devices, failed SSH key decoding, and dual-stack cloud-init', () => {
    const guest = parseVmProxmoxConfig(
      'agent: true\nciuser: fixture\ncipassword: fixture-password\nsshkeys: %invalid\nscsi0: disk,size=0\nvirtio0: size=8G\nsata0: local:iso,media=cdrom\nide2: local:cloudinit\nnet0: e1000=02:00:00:00:00:01,firewall=0,tag=8,mtu=1400\nnet1: bridge=vmbr1\nipconfig0: ip=192.0.2.2/24,gw=192.0.2.1,ip6=2001:db8::2/64,gw6=2001:db8::1\n[PENDING]\nmemory: 2048\n[backup]\ncores: 2\n',
    );
    expect(guest.type).toBe('vm');
    if (guest.type !== 'vm') throw new Error('fixture must be VM');
    expect(guest.cloud_init?.ssh_keys).toEqual(['%invalid']);
    expect(guest.disks).toHaveLength(2);
    expect(guest.network[0]).toMatchObject({
      firewall: false,
      vlan: 8,
      mtu: 1400,
    });
    const text = serialiseVmProxmoxConfig(guest);
    expect(text).toContain('gw6=2001:db8::1');
    expect(text).toContain('ip6=2001:db8::2/64');
    expect(text).toContain('[backup]');
    expect(text).toContain('[PENDING]');
    expect(text).toContain('media=cdrom');
    expect(parseVmProxmoxConfig('ciuser: fixture').type).toBe('vm');
  });

  it('serializes newly authored VM disks and optional network/cloud-init fields', () => {
    const guest = parseVmProxmoxConfig('');
    if (guest.type !== 'vm') throw new Error('fixture must be VM');
    const text = serialiseVmProxmoxConfig({
      ...guest,
      cpu: { tag: 'expr', value: '2' },
      ram: undefined as unknown as number,
      cloud_init: {},
      disks: [{ name: 'scsi0', storage: 'local', size_gb: 10 }],
      network: [{ index: 0, mac: '02:00:00:00:00:01' }],
    });
    expect(text).toContain('scsi0: local:vm-200-disk-1,size=10G');
    expect(text).toContain('net0: virtio=02:00:00:00:00:01');
    expect(text).not.toContain('ipconfig0:');
  });
});

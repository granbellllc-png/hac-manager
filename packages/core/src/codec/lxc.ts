import type { GuestDeployment } from '../schema/deployment.js';
import {
  formatOptionString,
  formatSizeGb,
  parseOptionString,
  parseSizeGb,
} from './options.js';
import {
  parseRawProxmoxConfig,
  serialiseRawProxmoxConfig,
  type RawProxmoxConfig,
} from './raw.js';

export function parseLxcProxmoxConfig(
  text: string,
  vmid = 100,
): GuestDeployment {
  const raw = parseRawProxmoxConfig(text);
  const main = { ...raw.main };

  const name = main['hostname'] ?? `lxc-${vmid}`;
  delete main['hostname'];

  const cpu = main['cores'] ? parseInt(main['cores'], 10) : 1;
  delete main['cores'];

  const ram = main['memory'] ? parseInt(main['memory'], 10) : 512;
  delete main['memory'];

  let swap: number | undefined = undefined;
  if (main['swap'] !== undefined) {
    swap = parseInt(main['swap'], 10);
    delete main['swap'];
  }

  let unprivileged: boolean | undefined = undefined;
  if (main['unprivileged'] !== undefined) {
    unprivileged =
      main['unprivileged'] === '1' || main['unprivileged'] === 'true';
    delete main['unprivileged'];
  }

  let ostype: string | undefined = undefined;
  if (main['ostype']) {
    ostype = main['ostype'];
    delete main['ostype'];
  }

  let onboot: boolean | undefined = undefined;
  if (main['onboot'] !== undefined) {
    onboot = main['onboot'] === '1' || main['onboot'] === 'true';
    delete main['onboot'];
  }

  let startup: string | undefined = undefined;
  if (main['startup']) {
    startup = main['startup'];
    delete main['startup'];
  }

  let tags: string[] | undefined = undefined;
  if (main['tags']) {
    tags = main['tags']
      .split(/[;,]/)
      .map((t) => t.trim())
      .filter(Boolean);
    delete main['tags'];
  }

  let features:
    | { nesting?: boolean; keyctl?: boolean; fuse?: boolean; mount?: string[] }
    | undefined = undefined;
  if (main['features']) {
    const parsedFeatures = parseOptionString(main['features']);
    features = {
      nesting: parsedFeatures.options['nesting'] === '1',
      keyctl: parsedFeatures.options['keyctl'] === '1',
      fuse: parsedFeatures.options['fuse'] === '1',
      ...(parsedFeatures.options['mount']
        ? { mount: parsedFeatures.options['mount'].split(';') }
        : {}),
    };
    delete main['features'];
  }

  // Disks (rootfs)
  const disks: GuestDeployment['disks'] = [];
  if (main['rootfs']) {
    const parsedRootfs = parseOptionString(main['rootfs']);
    const positional = parsedRootfs.positional ?? '';
    const colonIdx = positional.indexOf(':');
    const storage =
      colonIdx !== -1 ? positional.slice(0, colonIdx) : 'local-lvm';
    const volume =
      colonIdx !== -1 ? positional.slice(colonIdx + 1) : positional;
    const sizeGb = parseSizeGb(parsedRootfs.options['size']);

    const diskExtra: Record<string, unknown> = { ...parsedRootfs.options };
    delete diskExtra['size'];
    if (volume) {
      diskExtra['volume'] = volume;
    }

    disks.push({
      name: 'rootfs',
      storage,
      size_gb: sizeGb > 0 ? sizeGb : 8,
      extra: Object.keys(diskExtra).length > 0 ? diskExtra : undefined,
    });
    delete main['rootfs'];
  }

  // Mounts (mp0, mp1, ...)
  const mounts: NonNullable<GuestDeployment['mounts']> = [];
  const mpKeys = Object.keys(main)
    .filter((k) => /^mp\d+$/.test(k))
    .sort();
  for (const mpKey of mpKeys) {
    const idx = parseInt(mpKey.slice(2), 10);
    const parsedMp = parseOptionString(main[mpKey]!);
    const hostPath = parsedMp.positional ?? '';
    const guestPath = parsedMp.options['mp'] ?? '';
    const backup = parsedMp.options['backup'] === '1';
    const ro =
      parsedMp.options['ro'] === '1' || parsedMp.options['readonly'] === '1';

    mounts.push({
      index: idx,
      host_path: hostPath,
      guest_path: guestPath,
      backup: backup || undefined,
      readonly: ro || undefined,
      permissions: 'minimal',
    });
    delete main[mpKey];
  }

  // Networks (net0, net1, ...)
  const network: GuestDeployment['network'] = [];
  const netKeys = Object.keys(main)
    .filter((k) => /^net\d+$/.test(k))
    .sort();
  for (const netKey of netKeys) {
    const idx = parseInt(netKey.slice(3), 10);
    const parsedNet = parseOptionString(main[netKey]!);

    const netExtra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsedNet.options)) {
      if (
        ![
          'name',
          'bridge',
          'firewall',
          'hwaddr',
          'ip',
          'gw',
          'ip6',
          'gw6',
          'tag',
          'vlan',
          'mtu',
          'type',
        ].includes(k)
      ) {
        netExtra[k] = v;
      }
    }
    if (parsedNet.options['type']) {
      netExtra['type'] = parsedNet.options['type'];
    }

    const vlanStr = parsedNet.options['tag'] ?? parsedNet.options['vlan'];
    const vlan = vlanStr ? parseInt(vlanStr, 10) : undefined;
    const mtu = parsedNet.options['mtu']
      ? parseInt(parsedNet.options['mtu'], 10)
      : undefined;
    const firewall = parsedNet.options['firewall']
      ? parsedNet.options['firewall'] === '1'
      : undefined;
    const ip6 = parsedNet.options['ip6'];
    const ipv6: GuestDeployment['network'][number]['ipv6'] | undefined =
      ip6 === 'auto'
        ? 'auto'
        : ip6 === 'dhcp'
          ? 'dhcp'
          : ip6 === 'manual'
            ? 'disabled'
            : ip6
              ? 'static'
              : undefined;

    network.push({
      index: idx,
      name: parsedNet.options['name'],
      bridge: parsedNet.options['bridge'],
      mac: parsedNet.options['hwaddr'],
      ip: parsedNet.options['ip'],
      gateway: parsedNet.options['gw'],
      ip6,
      gateway6: parsedNet.options['gw6'],
      ipv6,
      vlan,
      mtu,
      firewall,
      extra: Object.keys(netExtra).length > 0 ? netExtra : undefined,
    });
    delete main[netKey];
  }

  const extra: Record<string, unknown> = { ...main };
  if (raw.pending && Object.keys(raw.pending).length > 0) {
    extra['_pending'] = raw.pending;
  }
  if (raw.snapshots && Object.keys(raw.snapshots).length > 0) {
    extra['_snapshots'] = raw.snapshots;
  }

  return {
    schema_version: 1,
    id: vmid,
    name,
    type: 'lxc',
    cpu,
    ram,
    swap,
    unprivileged,
    ostype,
    onboot,
    startup,
    tags,
    features,
    disks,
    mounts: mounts.length > 0 ? mounts : undefined,
    network,
    extra: Object.keys(extra).length > 0 ? extra : undefined,
  };
}

function valToStr(val: unknown): string {
  if (val === undefined || val === null) return '';
  if (typeof val === 'object' && val !== null && 'tag' in val) {
    return String((val as { value?: unknown }).value ?? '');
  }
  return String(val);
}

export function serialiseLxcProxmoxConfig(guest: GuestDeployment): string {
  if (guest.type !== 'lxc') {
    throw new Error(`Expected LXC guest deployment, got ${guest.type}`);
  }

  const main: Record<string, string> = {};

  if (guest.extra) {
    for (const [k, v] of Object.entries(guest.extra)) {
      if (k !== '_pending' && k !== '_snapshots') {
        main[k] = String(v);
      }
    }
  }

  main['hostname'] = guest.name;
  main['cores'] = valToStr(guest.cpu);
  main['memory'] = valToStr(guest.ram);
  if (guest.swap !== undefined) {
    main['swap'] = valToStr(guest.swap);
  }
  if (guest.unprivileged !== undefined) {
    main['unprivileged'] = guest.unprivileged ? '1' : '0';
  }
  if (guest.ostype) {
    main['ostype'] = guest.ostype;
  }
  if (guest.onboot !== undefined) {
    main['onboot'] = guest.onboot ? '1' : '0';
  }
  if (guest.startup !== undefined) {
    main['startup'] = valToStr(guest.startup);
  }
  if (guest.tags && guest.tags.length > 0) {
    main['tags'] = guest.tags.join(';');
  }

  if (guest.features) {
    const f = guest.features;
    const fOpts: Record<string, string> = {};
    if (f.nesting) fOpts['nesting'] = '1';
    if (f.keyctl) fOpts['keyctl'] = '1';
    if (f.fuse) fOpts['fuse'] = '1';
    if (f.mount && f.mount.length > 0) fOpts['mount'] = f.mount.join(';');
    if (Object.keys(fOpts).length > 0) {
      main['features'] = formatOptionString(undefined, fOpts);
    }
  }

  // Rootfs disk
  const rootfsDisk = guest.disks.find((d) => d.name === 'rootfs');
  if (rootfsDisk) {
    const volume =
      (rootfsDisk.extra?.['volume'] as string | undefined) ??
      `vm-${guest.id}-disk-0`;
    const positional = `${valToStr(rootfsDisk.storage)}:${volume}`;
    const opts: Record<string, string> = {
      size: formatSizeGb(Number(valToStr(rootfsDisk.size_gb))),
    };
    if (rootfsDisk.extra) {
      for (const [k, v] of Object.entries(rootfsDisk.extra)) {
        if (k !== 'volume' && k !== 'size') {
          opts[k] = String(v);
        }
      }
    }
    main['rootfs'] = formatOptionString(positional, opts);
  }

  // Mounts
  if (guest.mounts) {
    for (const m of guest.mounts) {
      const positional = m.host_path;
      const opts: Record<string, string> = {
        mp: m.guest_path,
      };
      if (m.backup) opts['backup'] = '1';
      if (m.readonly) opts['ro'] = '1';
      main[`mp${m.index}`] = formatOptionString(positional, opts);
    }
  }

  // Network
  for (const n of guest.network) {
    const opts: Record<string, string> = {};
    if (n.name) opts['name'] = n.name;
    if (n.bridge) opts['bridge'] = valToStr(n.bridge);
    if (n.firewall !== undefined) opts['firewall'] = n.firewall ? '1' : '0';
    if (n.gateway) opts['gw'] = valToStr(n.gateway);
    if (n.gateway6) opts['gw6'] = valToStr(n.gateway6);
    if (n.mac) opts['hwaddr'] = valToStr(n.mac);
    if (n.ip) opts['ip'] = valToStr(n.ip);
    if (n.ip6) {
      opts['ip6'] = valToStr(n.ip6);
    } else if (n.ipv6 === 'auto' || n.ipv6 === 'dhcp') {
      opts['ip6'] = n.ipv6;
    } else if (n.ipv6 === 'disabled' || n.ipv6 === 'static') {
      opts['ip6'] = 'manual';
    }
    if (n.vlan !== undefined) opts['tag'] = valToStr(n.vlan);
    if (n.mtu !== undefined) opts['mtu'] = valToStr(n.mtu);
    if (n.extra) {
      for (const [k, v] of Object.entries(n.extra)) {
        opts[k] = String(v);
      }
    }
    main[`net${n.index}`] = formatOptionString(undefined, opts, [
      'name',
      'bridge',
      'gw',
      'hwaddr',
      'ip',
      'type',
    ]);
  }

  const rawConfig: RawProxmoxConfig = {
    main,
    pending: guest.extra?.['_pending'] as Record<string, string> | undefined,
    snapshots: guest.extra?.['_snapshots'] as
      Record<string, Record<string, string>> | undefined,
  };

  return serialiseRawProxmoxConfig(rawConfig);
}

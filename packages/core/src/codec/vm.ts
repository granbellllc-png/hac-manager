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

export function parseVmProxmoxConfig(
  text: string,
  vmid = 200,
): GuestDeployment {
  const raw = parseRawProxmoxConfig(text);
  const main = { ...raw.main };

  const name = main['name'] ?? `vm-${vmid}`;
  delete main['name'];

  const cpu = main['cores'] ? parseInt(main['cores'], 10) : 1;
  delete main['cores'];

  const ram = main['memory'] ? parseInt(main['memory'], 10) : 1024;
  delete main['memory'];

  const bios = main['bios'] === 'ovmf' ? 'ovmf' : 'seabios';
  delete main['bios'];

  let machine: string | undefined = undefined;
  if (main['machine']) {
    machine = main['machine'];
    delete main['machine'];
  }

  const guestAgent = main['agent'] === '1' || main['agent'] === 'true';
  delete main['agent'];

  const efiDisk = Boolean(main['efidisk0']);
  const tpm = Boolean(main['tpmstate0']);

  // Cloud-init
  let cloudInit: Extract<GuestDeployment, { type: 'vm' }>['cloud_init'] =
    undefined;
  const ciUser = main['ciuser'];
  const ciPassword = main['cipassword'];
  const ciSshKeys = main['sshkeys'];
  delete main['ciuser'];
  delete main['cipassword'];
  delete main['sshkeys'];

  if (ciUser || ciPassword || ciSshKeys) {
    const keysList: string[] = [];
    if (ciSshKeys) {
      try {
        const decoded = decodeURIComponent(ciSshKeys.replace(/\+/g, '%20'));
        keysList.push(decoded);
      } catch {
        keysList.push(ciSshKeys);
      }
    }
    cloudInit = {
      user: ciUser,
      password: ciPassword,
      ssh_keys: keysList.length > 0 ? keysList : undefined,
    };
  }

  // Disks (scsi0, virtio0, sata0, ide0, ...)
  const disks: GuestDeployment['disks'] = [];
  const diskKeys = Object.keys(main)
    .filter((k) => /^(scsi|virtio|sata|ide)\d+$/.test(k))
    .sort();

  for (const dKey of diskKeys) {
    const val = main[dKey]!;
    if (val.includes('media=cdrom') || val.includes('cloudinit')) {
      // cloudinit or cdrom kept in extra
      continue;
    }

    const parsed = parseOptionString(val);
    const positional = parsed.positional ?? '';
    const colonIdx = positional.indexOf(':');
    const storage =
      colonIdx !== -1 ? positional.slice(0, colonIdx) : 'local-lvm';
    const volume =
      colonIdx !== -1 ? positional.slice(colonIdx + 1) : positional;
    const sizeGb = parseSizeGb(parsed.options['size']);

    const diskExtra: Record<string, unknown> = { ...parsed.options };
    delete diskExtra['size'];
    if (volume) {
      diskExtra['volume'] = volume;
    }

    disks.push({
      name: dKey,
      storage,
      size_gb: sizeGb > 0 ? sizeGb : 10,
      extra: Object.keys(diskExtra).length > 0 ? diskExtra : undefined,
    });
    delete main[dKey];
  }

  // Network (net0, net1, ... combined with ipconfig0, ipconfig1, ...)
  const network: GuestDeployment['network'] = [];
  const netKeys = Object.keys(main)
    .filter((k) => /^net\d+$/.test(k))
    .sort();

  for (const netKey of netKeys) {
    const idx = parseInt(netKey.slice(3), 10);
    const parsedNet = parseOptionString(main[netKey]!);
    delete main[netKey];

    const ipconfigKey = `ipconfig${idx}`;
    const parsedIpconfig = main[ipconfigKey]
      ? parseOptionString(main[ipconfigKey]!)
      : undefined;
    if (parsedIpconfig) {
      delete main[ipconfigKey];
    }

    let mac: string | undefined = undefined;
    let model: string | undefined = undefined;
    for (const [k, v] of Object.entries(parsedNet.options)) {
      if (['virtio', 'e1000', 'rtl8139', 'vmxnet3'].includes(k)) {
        model = k;
        mac = v;
      }
    }

    const netExtra: Record<string, unknown> = {};
    if (model) netExtra['model'] = model;

    const bridge = parsedNet.options['bridge'];
    const firewall = parsedNet.options['firewall']
      ? parsedNet.options['firewall'] === '1'
      : undefined;
    const vlanStr = parsedNet.options['tag'];
    const vlan = vlanStr ? parseInt(vlanStr, 10) : undefined;
    const mtu = parsedNet.options['mtu']
      ? parseInt(parsedNet.options['mtu'], 10)
      : undefined;

    const ip = parsedIpconfig?.options['ip'];
    const gw = parsedIpconfig?.options['gw'];
    const ip6 = parsedIpconfig?.options['ip6'];
    const gw6 = parsedIpconfig?.options['gw6'];

    network.push({
      index: idx,
      bridge,
      mac,
      firewall,
      vlan,
      mtu,
      ip,
      gateway: gw,
      ip6,
      gateway6: gw6,
      extra: Object.keys(netExtra).length > 0 ? netExtra : undefined,
    });
  }

  let tags: string[] | undefined = undefined;
  if (main['tags'] !== undefined) {
    tags = main['tags']
      .split(';')
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);
    delete main['tags'];
  }

  let protection: boolean | undefined = undefined;
  if (main['protection'] !== undefined) {
    protection = main['protection'] === '1' || main['protection'] === 'true';
    delete main['protection'];
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
    type: 'vm',
    cpu,
    ram,
    bios,
    machine,
    guest_agent: guestAgent || undefined,
    efi_disk: efiDisk || undefined,
    tpm: tpm || undefined,
    cloud_init: cloudInit,
    tags,
    protection,
    disks,
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

export function serialiseVmProxmoxConfig(guest: GuestDeployment): string {
  if (guest.type !== 'vm') {
    throw new Error(`Expected VM guest deployment, got ${guest.type}`);
  }

  const main: Record<string, string> = {};

  if (guest.extra) {
    for (const [k, v] of Object.entries(guest.extra)) {
      if (k !== '_pending' && k !== '_snapshots') {
        main[k] = String(v);
      }
    }
  }

  main['name'] = guest.name;
  main['cores'] = valToStr(guest.cpu);
  main['memory'] = valToStr(guest.ram);

  if (guest.bios) main['bios'] = guest.bios;
  if (guest.machine) main['machine'] = guest.machine;
  if (guest.protection !== undefined) {
    main['protection'] = guest.protection ? '1' : '0';
  }
  if (guest.tags && guest.tags.length > 0) {
    main['tags'] = guest.tags.join(';');
  }
  if (guest.guest_agent) main['agent'] = '1';
  const storage = valToStr(guest.disks[0]?.storage) || 'local-lvm';
  if (guest.efi_disk && !main['efidisk0']) {
    main['efidisk0'] = `${storage}:1,efitype=4m,pre-enrolled-keys=1`;
  }
  if (guest.tpm && !main['tpmstate0']) {
    main['tpmstate0'] = `${storage}:1,version=v2.0`;
  }
  if (guest.cloud_init) {
    if (guest.cloud_init.user) main['ciuser'] = valToStr(guest.cloud_init.user);
    if (guest.cloud_init.password)
      main['cipassword'] = valToStr(guest.cloud_init.password);
    if (guest.cloud_init.ssh_keys && guest.cloud_init.ssh_keys.length > 0) {
      main['sshkeys'] = encodeURIComponent(
        guest.cloud_init.ssh_keys.map((k: unknown) => valToStr(k)).join('\n'),
      );
    }
  }

  // Disks
  for (const d of guest.disks) {
    const volume =
      (d.extra?.['volume'] as string | undefined) ?? `vm-${guest.id}-disk-1`;
    const positional = `${valToStr(d.storage)}:${volume}`;
    const opts: Record<string, string> = {
      size: formatSizeGb(Number(valToStr(d.size_gb))),
    };
    if (d.extra) {
      for (const [k, v] of Object.entries(d.extra)) {
        if (k !== 'volume' && k !== 'size') {
          opts[k] = String(v);
        }
      }
    }
    main[d.name] = formatOptionString(positional, opts);
  }

  // Network & ipconfig
  for (const n of guest.network) {
    const model = (n.extra?.['model'] as string | undefined) ?? 'virtio';
    const netOpts: Record<string, string> = {};
    if (n.mac) netOpts[model] = valToStr(n.mac);
    if (n.bridge) netOpts['bridge'] = valToStr(n.bridge);
    if (n.firewall !== undefined) netOpts['firewall'] = n.firewall ? '1' : '0';
    if (n.vlan !== undefined) netOpts['tag'] = valToStr(n.vlan);
    if (n.mtu !== undefined) netOpts['mtu'] = valToStr(n.mtu);
    main[`net${n.index}`] = formatOptionString(undefined, netOpts);

    if (n.ip || n.gateway || n.ip6 || n.gateway6) {
      const ipOpts: Record<string, string> = {};
      if (n.ip) ipOpts['ip'] = valToStr(n.ip);
      if (n.gateway) ipOpts['gw'] = valToStr(n.gateway);
      if (n.ip6) ipOpts['ip6'] = valToStr(n.ip6);
      if (n.gateway6) ipOpts['gw6'] = valToStr(n.gateway6);
      main[`ipconfig${n.index}`] = formatOptionString(undefined, ipOpts);
    }
  }

  const rawConfig: RawProxmoxConfig = {
    main,
    pending: guest.extra?.['_pending'] as Record<string, string> | undefined,
    snapshots: guest.extra?.['_snapshots'] as
      Record<string, Record<string, string>> | undefined,
  };

  return serialiseRawProxmoxConfig(rawConfig);
}

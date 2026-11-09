import { Document } from 'yaml';
import type {
  GenerateDeploymentYamlOptions,
  GenerateDeploymentYamlResult,
} from './types.js';

function isDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined)
    return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, idx) => isDeepEqual(item, b[idx]));
  }
  const keysA = Object.keys(a as Record<string, unknown>);
  const keysB = Object.keys(b as Record<string, unknown>);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) =>
    isDeepEqual(
      (a as Record<string, unknown>)[key],
      (b as Record<string, unknown>)[key],
    ),
  );
}

export function generateDeploymentYaml(
  options: GenerateDeploymentYamlOptions,
): GenerateDeploymentYamlResult {
  const { guest, defaults } = options;
  const omittedDefaults: string[] = [];

  const checkOmit = (
    prop: string,
    guestVal: unknown,
    defaultVal: unknown,
  ): boolean => {
    if (defaultVal !== undefined && isDeepEqual(guestVal, defaultVal)) {
      omittedDefaults.push(prop);
      return true;
    }
    return false;
  };

  const root: Record<string, unknown> = {
    schema_version: 1,
    id: guest.id,
    name: guest.name,
    type: guest.type,
  };

  if (!checkOmit('cpu', guest.cpu, defaults?.cpu)) {
    root['cpu'] = guest.cpu;
  }

  if (!checkOmit('ram', guest.ram, defaults?.ram)) {
    root['ram'] = guest.ram;
  }

  if (
    guest.protection !== undefined &&
    !checkOmit('protection', guest.protection, defaults?.protection)
  ) {
    root['protection'] = guest.protection;
  }

  if (guest.type === 'lxc') {
    if (
      guest.unprivileged !== undefined &&
      !checkOmit('unprivileged', guest.unprivileged, defaults?.unprivileged)
    ) {
      root['unprivileged'] = guest.unprivileged;
    }
    if (
      guest.swap !== undefined &&
      !checkOmit('swap', guest.swap, defaults?.swap)
    ) {
      root['swap'] = guest.swap;
    }
    if (guest.ostype && !checkOmit('ostype', guest.ostype, defaults?.ostype)) {
      root['ostype'] = guest.ostype;
    }
    if (
      guest.onboot !== undefined &&
      !checkOmit('onboot', guest.onboot, defaults?.onboot)
    ) {
      root['onboot'] = guest.onboot;
    }
    if (
      guest.startup !== undefined &&
      !checkOmit('startup', guest.startup, defaults?.startup)
    ) {
      root['startup'] = guest.startup;
    }
    if (
      guest.features &&
      !checkOmit('features', guest.features, defaults?.features)
    ) {
      root['features'] = guest.features;
    }
  }

  if (guest.type === 'vm') {
    if (guest.bios && !checkOmit('bios', guest.bios, defaults?.bios)) {
      root['bios'] = guest.bios;
    }
    if (
      guest.machine &&
      !checkOmit('machine', guest.machine, defaults?.machine)
    ) {
      root['machine'] = guest.machine;
    }
    if (
      guest.guest_agent !== undefined &&
      !checkOmit('guest_agent', guest.guest_agent, defaults?.guest_agent)
    ) {
      root['guest_agent'] = guest.guest_agent;
    }
    if (
      guest.efi_disk !== undefined &&
      !checkOmit('efi_disk', guest.efi_disk, defaults?.efi_disk)
    ) {
      root['efi_disk'] = guest.efi_disk;
    }
    if (
      guest.tpm !== undefined &&
      !checkOmit('tpm', guest.tpm, defaults?.tpm)
    ) {
      root['tpm'] = guest.tpm;
    }
    if (
      guest.cloud_init &&
      !checkOmit('cloud_init', guest.cloud_init, defaults?.cloud_init)
    ) {
      root['cloud_init'] = guest.cloud_init;
    }
  }

  // Disks
  const cleanedDisks = guest.disks.map((d) => {
    if (!d.extra) return d;
    const cleanExtra = { ...d.extra };
    delete cleanExtra['_pending'];
    delete cleanExtra['_snapshots'];
    return {
      name: d.name,
      storage: d.storage,
      size_gb: d.size_gb,
      ...(Object.keys(cleanExtra).length > 0 ? { extra: cleanExtra } : {}),
    };
  });
  if (
    cleanedDisks.length > 0 &&
    !checkOmit('disks', cleanedDisks, defaults?.disks)
  ) {
    root['disks'] = cleanedDisks;
  }

  // Mounts
  if (
    guest.mounts &&
    guest.mounts.length > 0 &&
    !checkOmit('mounts', guest.mounts, defaults?.mounts)
  ) {
    root['mounts'] = guest.mounts;
  }

  // Network
  if (
    guest.network &&
    guest.network.length > 0 &&
    !checkOmit('network', guest.network, defaults?.network)
  ) {
    root['network'] = guest.network;
  }

  // Tags
  if (
    guest.tags &&
    guest.tags.length > 0 &&
    !checkOmit('tags', guest.tags, defaults?.tags)
  ) {
    root['tags'] = guest.tags;
  }

  // Extra (clean internal keys)
  if (guest.extra) {
    const cleanExtra = { ...guest.extra };
    delete cleanExtra['_pending'];
    delete cleanExtra['_snapshots'];
    if (
      Object.keys(cleanExtra).length > 0 &&
      !checkOmit('extra', cleanExtra, defaults?.extra)
    ) {
      root['extra'] = cleanExtra;
    }
  }

  const doc = new Document(root);
  doc.commentBefore = ` Generated by hacm import from live state on ${(options.generatedAt ?? new Date()).toISOString()}`;

  return {
    yamlContent: doc.toString(),
    omittedDefaults,
  };
}

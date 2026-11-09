import type { GuestDeployment } from '../schema/deployment.js';
import { parseLxcProxmoxConfig, serialiseLxcProxmoxConfig } from './lxc.js';
import { parseVmProxmoxConfig, serialiseVmProxmoxConfig } from './vm.js';

export function detectProxmoxConfigType(text: string): 'lxc' | 'vm' {
  if (
    text.includes('hostname:') ||
    text.includes('rootfs:') ||
    text.includes('unprivileged:')
  ) {
    return 'lxc';
  }
  if (
    text.includes('bios:') ||
    text.includes('scsihw:') ||
    text.includes('efidisk0:') ||
    text.includes('machine:') ||
    text.includes('cipassword:')
  ) {
    return 'vm';
  }
  return 'lxc';
}

export function parseProxmoxConfig(
  text: string,
  type?: 'lxc' | 'vm',
  vmid = 100,
): GuestDeployment {
  const actualType = type ?? detectProxmoxConfigType(text);
  if (actualType === 'lxc') {
    return parseLxcProxmoxConfig(text, vmid);
  }
  return parseVmProxmoxConfig(text, vmid);
}

export function serialiseProxmoxConfig(guest: GuestDeployment): string {
  if (guest.type === 'lxc') {
    return serialiseLxcProxmoxConfig(guest);
  }
  return serialiseVmProxmoxConfig(guest);
}

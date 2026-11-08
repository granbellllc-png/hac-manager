import { ExpressionError, MacRangeError } from './types.js';

const macPrefixRegex = /^[0-9A-Fa-f]{2}:[0-9A-Fa-f]{2}:[0-9A-Fa-f]{2}$/;
const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function mac(
  prefix: unknown,
  hostIndex: unknown,
  netIndex: unknown,
  vmid: unknown,
): string {
  if (typeof prefix !== 'string' || !macPrefixRegex.test(prefix)) {
    throw new MacRangeError(
      `Prefix must be 3 colon-separated hex octets (e.g. 'A2:B1:C1'), received: ${String(prefix)}`,
    );
  }

  const hIdx = Number(hostIndex);
  if (!Number.isInteger(hIdx) || hIdx < 0 || hIdx > 99) {
    throw new MacRangeError(
      `host.index must be an integer between 0 and 99, received: ${String(hostIndex)}`,
    );
  }

  const nIdx = Number(netIndex);
  if (!Number.isInteger(nIdx) || nIdx < 0 || nIdx >= 10) {
    throw new MacRangeError(
      `net.index must be an integer between 0 and 9, received: ${String(netIndex)}`,
    );
  }

  const vmIdNum = Number(vmid);
  if (!Number.isInteger(vmIdNum) || vmIdNum < 100 || vmIdNum >= 200) {
    throw new MacRangeError(
      `vmid must be an integer between 100 and 199 for the human-readable MAC scheme, received: ${String(vmid)}`,
    );
  }

  const hostPart = String(hIdx).padStart(2, '0');
  const netPart = `E${nIdx}`;
  const vmidPart = String(vmIdNum - 100).padStart(2, '0');

  return `${prefix.toUpperCase()}:${hostPart}:${netPart}:${vmidPart}`;
}

export function pad(
  val: unknown,
  length: unknown,
  char: unknown = '0',
): string {
  const len = Number(length);
  if (!Number.isInteger(len) || len < 0 || len > 1000) {
    throw new ExpressionError(
      `pad length must be an integer between 0 and 1000, received: ${String(length)}`,
    );
  }
  const padChar =
    typeof char === 'string' && char.length > 0 ? char.charAt(0) : '0';
  return String(val ?? '').padStart(len, padChar);
}

export function hex(val: unknown, digits: unknown = 2): string {
  const num = Number(val);
  if (!Number.isInteger(num)) {
    throw new ExpressionError(
      `hex value must be an integer, received: ${String(val)}`,
    );
  }
  const dig = Number(digits);
  if (!Number.isInteger(dig) || dig < 1 || dig > 32) {
    throw new ExpressionError(
      `hex digits must be between 1 and 32, received: ${String(digits)}`,
    );
  }
  return num.toString(16).toUpperCase().padStart(dig, '0');
}

function parseIpv4(ip: string): number {
  const match = ipv4Regex.exec(ip.trim());
  if (!match) {
    throw new ExpressionError(`Invalid IPv4 address: ${ip}`);
  }
  const octets = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
  ];
  for (const octet of octets) {
    if (octet < 0 || octet > 255) {
      throw new ExpressionError(`IPv4 octet out of range (0-255): ${ip}`);
    }
  }
  return (
    ((octets[0]! << 24) |
      (octets[1]! << 16) |
      (octets[2]! << 8) |
      octets[3]!) >>>
    0
  );
}

function formatIpv4(intVal: number): string {
  const o1 = (intVal >>> 24) & 0xff;
  const o2 = (intVal >>> 16) & 0xff;
  const o3 = (intVal >>> 8) & 0xff;
  const o4 = intVal & 0xff;
  return `${o1}.${o2}.${o3}.${o4}`;
}

function splitCidr(cidr: string): { ip: string; prefix?: number | undefined } {
  const parts = cidr.trim().split('/');
  if (parts.length === 1) {
    return { ip: parts[0]! };
  }
  if (parts.length === 2) {
    const prefix = Number(parts[1]);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
      throw new ExpressionError(`Invalid CIDR prefix length: ${cidr}`);
    }
    return { ip: parts[0]!, prefix };
  }
  throw new ExpressionError(`Invalid CIDR notation: ${cidr}`);
}

export function ip_add(cidrOrIp: unknown, offset: unknown): string {
  if (typeof cidrOrIp !== 'string') {
    throw new ExpressionError(
      `ip_add expects an IP or CIDR string, received: ${String(cidrOrIp)}`,
    );
  }
  const off = Number(offset);
  if (!Number.isInteger(off)) {
    throw new ExpressionError(
      `ip_add offset must be an integer, received: ${String(offset)}`,
    );
  }

  const { ip, prefix } = splitCidr(cidrOrIp);
  const ipInt = parseIpv4(ip);
  const newInt = (ipInt + off) >>> 0;

  const resultIp = formatIpv4(newInt);
  return prefix !== undefined ? `${resultIp}/${prefix}` : resultIp;
}

export function ip_calc(cidr: unknown, hostNumber: unknown): string {
  if (typeof cidr !== 'string') {
    throw new ExpressionError(
      `ip_calc expects a CIDR string, received: ${String(cidr)}`,
    );
  }
  const hostNum = Number(hostNumber);
  if (!Number.isInteger(hostNum) || hostNum < 0) {
    throw new ExpressionError(
      `ip_calc hostNumber must be a non-negative integer, received: ${String(hostNumber)}`,
    );
  }

  const { ip, prefix } = splitCidr(cidr);
  const pfx = prefix ?? 32;
  const mask = pfx === 0 ? 0 : (~0 << (32 - pfx)) >>> 0;
  const baseNet = (parseIpv4(ip) & mask) >>> 0;
  const targetIp = (baseNet + hostNum) >>> 0;

  return formatIpv4(targetIp);
}

export function cidr_gateway(cidr: unknown): string {
  return ip_calc(cidr, 1);
}

export function cidr_netmask(cidr: unknown): string {
  if (typeof cidr !== 'string') {
    throw new ExpressionError(
      `cidr_netmask expects a CIDR string, received: ${String(cidr)}`,
    );
  }
  const { prefix } = splitCidr(cidr);
  const pfx = prefix ?? 32;
  const mask = pfx === 0 ? 0 : (~0 << (32 - pfx)) >>> 0;
  return formatIpv4(mask);
}

export function cidr_prefix(cidr: unknown): number {
  if (typeof cidr !== 'string') {
    throw new ExpressionError(
      `cidr_prefix expects a CIDR string, received: ${String(cidr)}`,
    );
  }
  const { prefix } = splitCidr(cidr);
  return prefix ?? 32;
}

export const builtInHelpers: Record<string, (...args: unknown[]) => unknown> = {
  mac,
  pad,
  hex,
  ip_add,
  ip_calc,
  cidr_gateway,
  cidr_netmask,
  cidr_prefix,
};

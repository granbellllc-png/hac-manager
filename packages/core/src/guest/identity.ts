import { createHash } from 'node:crypto';
import type { GuestDeployment, GuestType } from '../index.js';

/** Proxmox tag applied to every guest managed by HAC Manager (D-38). */
export const MANAGED_GUEST_TAG = 'hacm-managed';

const STAMP_PREFIX = MANAGED_GUEST_TAG;
const STAMP_PATTERN =
  /(?:^|\n)[ \t]*hacm-managed:[ \t]*([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})[ \t]*(?=\n|$)/;

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Deterministic UUID for a host/VMID pair. Storing the expected value in the
 * guest description detects a reused VMID without requiring another database
 * or file next to the YAML (D-38). The name is verified separately.
 */
export function managedGuestUuid(hostId: string, vmid: number): string {
  if (!hostId.trim()) throw new Error('hostId is required');
  if (!Number.isInteger(vmid) || vmid < 1) {
    throw new Error('vmid must be a positive integer');
  }
  const digest = createHash('sha1')
    .update(`hacm-managed:${hostId}:${vmid}`)
    .digest();
  // RFC 4122 version 5 (SHA-1 name-based) layout.
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

export interface ManagedIdentityFields {
  readonly tags?: readonly string[] | undefined;
  readonly description?: string | undefined;
}

/** Extract the HAC Manager stamp UUID from a Proxmox description. */
export function parseManagedGuestUuid(
  description: string | undefined,
): string | undefined {
  if (!description) return undefined;
  const match = STAMP_PATTERN.exec(description);
  return match?.[1]?.toLowerCase();
}

export function isManagedGuestTag(
  tags: readonly string[] | undefined,
): boolean {
  return Boolean(tags?.includes(MANAGED_GUEST_TAG));
}

export interface StampResult {
  readonly tags: readonly string[];
  readonly description: string;
  readonly changed: boolean;
}

/**
 * Add the managed tag and stamp UUID while preserving user tags, description
 * text and ordering. Re-stamping replaces the previous UUID in place.
 */
export function stampManagedIdentity(
  fields: ManagedIdentityFields,
  uuid: string,
): StampResult {
  if (!UUID_PATTERN.test(uuid)) {
    throw new Error('Managed guest UUID is malformed');
  }
  const tags = [...(fields.tags ?? [])];
  if (!tags.includes(MANAGED_GUEST_TAG)) tags.push(MANAGED_GUEST_TAG);

  const description = fields.description ?? '';
  const stampLine = `${STAMP_PREFIX}: ${uuid.toLowerCase()}`;
  let nextDescription: string;
  if (STAMP_PATTERN.test(description)) {
    nextDescription = description.replace(STAMP_PATTERN, (match) => {
      const leading = match.startsWith('\n') ? '\n' : '';
      return `${leading}${stampLine}`;
    });
  } else {
    const separator =
      description.length === 0 ? '' : description.endsWith('\n') ? '' : '\n';
    nextDescription = `${description}${separator}${stampLine}`;
  }

  return {
    tags,
    description: nextDescription,
    changed:
      tags.length !== (fields.tags?.length ?? 0) ||
      nextDescription !== (fields.description ?? ''),
  };
}

/** Remove the managed tag and stamp, used by explicit unmanage actions. */
export function stripManagedIdentity(
  fields: ManagedIdentityFields,
): StampResult {
  const tags = (fields.tags ?? []).filter((tag) => tag !== MANAGED_GUEST_TAG);
  const description = (fields.description ?? '')
    .replace(STAMP_PATTERN, '')
    .replace(/^\n+|\n+$/g, '');
  return {
    tags,
    description,
    changed:
      tags.length !== (fields.tags?.length ?? 0) ||
      description !== (fields.description ?? ''),
  };
}

export interface ExpectedGuestIdentity {
  readonly hostId: string;
  readonly vmid: number;
  readonly name: string;
  readonly type?: GuestType | undefined;
}

export interface LiveGuestIdentity extends ManagedIdentityFields {
  readonly exists: boolean;
  readonly vmid: number;
  readonly name?: string | undefined;
  readonly type?: GuestType | undefined;
  readonly status?: string | undefined;
}

export type GuestIdentityStatus =
  | 'missing'
  | 'verified'
  | 'unmanaged'
  | 'name-mismatch'
  | 'type-mismatch'
  | 'stamp-mismatch';

export interface GuestIdentityAssessment {
  readonly status: GuestIdentityStatus;
  readonly ok: boolean;
  readonly expectedUuid: string;
  readonly actualUuid?: string | undefined;
  readonly messages: readonly string[];
}

export function assessGuestIdentity(
  expected: ExpectedGuestIdentity,
  live: LiveGuestIdentity,
): GuestIdentityAssessment {
  const expectedUuid = managedGuestUuid(expected.hostId, expected.vmid);
  if (!live.exists) {
    return {
      status: 'missing',
      ok: false,
      expectedUuid,
      messages: [
        `Guest ${expected.vmid} does not exist on host '${expected.hostId}'.`,
      ],
    };
  }

  const actualUuid = parseManagedGuestUuid(live.description);
  const type = live.type ?? expected.type;
  if (expected.type && type && expected.type !== type) {
    return {
      status: 'type-mismatch',
      ok: false,
      expectedUuid,
      ...(actualUuid ? { actualUuid } : {}),
      messages: [
        `VMID ${expected.vmid} is a ${type}, but the YAML describes a ${expected.type}.`,
      ],
    };
  }

  if (live.name && live.name !== expected.name) {
    return {
      status: 'name-mismatch',
      ok: false,
      expectedUuid,
      ...(actualUuid ? { actualUuid } : {}),
      messages: [
        `VMID ${expected.vmid} on host '${expected.hostId}' is '${live.name}', not '${expected.name}'. Refusing to touch a different workload.`,
      ],
    };
  }

  if (actualUuid && actualUuid !== expectedUuid) {
    return {
      status: 'stamp-mismatch',
      ok: false,
      expectedUuid,
      actualUuid,
      messages: [
        `VMID ${expected.vmid} carries management stamp '${actualUuid}', expected '${expectedUuid}'. The VMID was probably reused.`,
      ],
    };
  }

  if (!actualUuid || !isManagedGuestTag(live.tags)) {
    return {
      status: 'unmanaged',
      ok: false,
      expectedUuid,
      ...(actualUuid ? { actualUuid } : {}),
      messages: [
        `Guest ${expected.vmid} is not stamped as managed. Stamp it explicitly before mutating it.`,
      ],
    };
  }

  return {
    status: 'verified',
    ok: true,
    expectedUuid,
    actualUuid,
    messages: [],
  };
}

/** Convert a canonical Proxmox config to the fields used by identity checks. */
export function liveIdentityFromDeployment(
  deployment: GuestDeployment,
  options: {
    readonly exists: boolean;
    readonly status?: string | undefined;
  },
): LiveGuestIdentity {
  const description = deployment.extra?.['description'];
  return {
    exists: options.exists,
    vmid: deployment.id,
    name: deployment.name,
    type: deployment.type,
    status: options.status,
    tags: deployment.tags,
    description: typeof description === 'string' ? description : undefined,
  };
}

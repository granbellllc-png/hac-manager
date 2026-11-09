import {
  ignoredGuestMatches,
  listIgnoredGuests,
  type IgnoredGuestEntry,
} from '@hacm/core';
import {
  getConfiguredGuestFromIndex,
  indexConfiguredGuests,
} from './configuration.js';
import type { LiveGuestSummary } from './types.js';

export type GuestConfigurationClassification =
  | {
      readonly status: 'configured';
      readonly relativePath: string;
    }
  | { readonly status: 'orphan' }
  | {
      readonly status: 'ignored';
      readonly entry: IgnoredGuestEntry;
    };

export interface ClassifiedGuest {
  readonly guest: LiveGuestSummary;
  readonly configuration: GuestConfigurationClassification;
}

function identityOf(guest: LiveGuestSummary) {
  return {
    vmid: guest.vmid,
    name: guest.name,
    type: guest.type,
    node: guest.node,
  };
}

/**
 * Decide whether every live guest is declared in YAML, intentionally ignored
 * or unmanaged. Ignored entries only apply while their stored fingerprint
 * still matches the live guest, so a reused VMID surfaces again (D-61/D-62).
 */
export async function classifyGuests(
  dataDir: string,
  guests: readonly LiveGuestSummary[],
): Promise<readonly ClassifiedGuest[]> {
  const configured = await indexConfiguredGuests(dataDir);
  const ignoredByHost = new Map<
    string,
    Promise<readonly IgnoredGuestEntry[]>
  >();

  const loadIgnored = (
    hostId: string,
  ): Promise<readonly IgnoredGuestEntry[]> => {
    const cached = ignoredByHost.get(hostId);
    if (cached) return cached;
    const entries = listIgnoredGuests(dataDir, hostId);
    ignoredByHost.set(hostId, entries);
    return entries;
  };

  return Promise.all(
    guests.map(async (guest) => {
      const declaration = getConfiguredGuestFromIndex(
        configured,
        guest.hostId,
        guest.vmid,
      );
      if (declaration) {
        return {
          guest,
          configuration: {
            status: 'configured' as const,
            relativePath: declaration.relativePath,
          },
        };
      }

      const entries = await loadIgnored(guest.hostId);
      const entry = entries.find((candidate) =>
        ignoredGuestMatches(candidate, identityOf(guest)),
      );
      return {
        guest,
        configuration: entry
          ? ({ status: 'ignored', entry } as const)
          : ({ status: 'orphan' } as const),
      };
    }),
  );
}

export const projectName = 'HAC Manager';
export const guestTypes = ['lxc', 'vm'] as const;
export type GuestType = (typeof guestTypes)[number];

export function isGuestType(value: unknown): value is GuestType {
  return guestTypes.some((type) => type === value);
}

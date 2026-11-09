/** Render an unknown thrown value as a human-readable message. */
export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

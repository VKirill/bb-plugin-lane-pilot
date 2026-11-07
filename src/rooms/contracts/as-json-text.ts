/** A stored value as displayable JSON text: strings pass through, structured values pretty-print, null/undefined stay absent. */
export function asJsonText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

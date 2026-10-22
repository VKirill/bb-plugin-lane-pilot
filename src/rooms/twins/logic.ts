/**
 * Twins checked against the real thing (SMA assess Q13, agent rule 4: «a double may do less than the library, never otherwise»). A test
 * double answers in place of BB (a thread, the providers, the plugins, a host command). Its answer's shape — keys and value types, never the
 * values — is compared with a recorded shape of the real answer (tests/fixtures/real-shapes, recorded by scripts/record-real-shapes.ts).
 * A double may leave a key out; a key the real answer does not have, or a different type, is a lie the tests would believe. A record older
 * than a year is stale: the real system has to be recorded again.
 */
export type Shape = string | { [key: string]: Shape } | [Shape];
export const RECORD_MAX_AGE_MS = 365 * 86_400_000;

/** The shape of a value: object keys with their shapes, an array's first element, or a primitive's type. Values never leave. */
export function shapeOf(value: unknown, depth = 0): Shape {
  if (depth > 8) return "deep";
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length ? [shapeOf(value[0], depth + 1)] : ["unknown"];
  if (typeof value === "object") return Object.fromEntries(Object.keys(value as object).sort().map((key) => [key, shapeOf((value as Record<string, unknown>)[key], depth + 1)]));
  return typeof value;
}

/** Where a twin's shape is not a part of the real one: a key the real has not, or another type. Leaving keys out is allowed. */
export function twinDiffers(twin: Shape, real: Shape, path = "$"): string[] {
  if (real === "unknown" || twin === "unknown" || real === "deep") return [];
  if (typeof twin === "string" || typeof real === "string") {
    // null stands for «absent here»: a real null may be a string elsewhere, so null on either side is not a lie.
    if (twin === "null" || real === "null") return [];
    return JSON.stringify(twin) === JSON.stringify(real) ? [] : [`${path}: the twin gives ${JSON.stringify(twin)}, the real thing ${JSON.stringify(real)}`];
  }
  if (Array.isArray(twin) || Array.isArray(real)) {
    if (!Array.isArray(twin) || !Array.isArray(real)) return [`${path}: one is a list and the other is not`];
    return twinDiffers(twin[0], real[0], `${path}[]`);
  }
  return Object.entries(twin).flatMap(([key, value]) => key in real ? twinDiffers(value, real[key]!, `${path}.${key}`) : [`${path}.${key}: the real thing has no such key`]);
}

import { lstat, readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import type { Stats } from "node:fs";

/**
 * Expected absence made explicit: a "may not exist" read returns its miss value only for the
 * anticipated absence, and every other failure propagates. Use instead of `.catch(() => null)`.
 */

/** Filesystem "no such path" — the only read failures a "or null" may hide. */
export const isFsAbsent = (cause: unknown): boolean => {
  const code = (cause as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/** Plugin/RPC "no such entity": PluginRpcCallError and PluginRpcRefusal carry code "not_found". */
export const isNotFound = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "not_found";

/** Text of a file that may not exist; null only when the path is absent — other failures throw. */
export async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    if (isFsAbsent(cause)) return null;
    throw cause;
  }
}

/** lstat of a path that may not exist; null only when absent — other failures throw. */
export async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (cause) {
    if (isFsAbsent(cause)) return null;
    throw cause;
  }
}

/** stat of a path that may not exist; null only when absent — other failures throw. */
export async function statOrNull(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch (cause) {
    if (isFsAbsent(cause)) return null;
    throw cause;
  }
}

/** Sync twin of readTextOrNull for callers that cannot await. */
export function readTextOrNullSync(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (cause) {
    if (isFsAbsent(cause)) return null;
    throw cause;
  }
}

/**
 * JSON that may be malformed by design (hand-edited file, legacy row): the parse's typed miss.
 * `fallback` is returned for any parse failure — use only where malformed input is expected.
 */
export function parseJsonOr<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/**
 * Typed miss for a read whose subject may be absent: `fallback` only when `expected`
 * names the anticipated failure (isFsAbsent, isNotFound); anything else propagates.
 */
export async function orMiss<T>(work: Promise<T>, fallback: T, expected: (cause: unknown) => boolean): Promise<T> {
  try {
    return await work;
  } catch (cause) {
    if (expected(cause)) return fallback;
    throw cause;
  }
}

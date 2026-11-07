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

const isNotFoundCode = (value: unknown): boolean =>
  typeof value === "string" && (value === "not_found" || value.endsWith("_not_found"));

const isHttp404 = (err: { status?: unknown; statusCode?: unknown; message?: unknown }): boolean => {
  if (err.status === 404 || err.status === "404" || err.statusCode === 404 || err.statusCode === "404") return true;
  const message = typeof err.message === "string" ? err.message : "";
  return /\bHTTP(?:\/\S+)?\s+404\b/.test(message);
};

/**
 * Plugin/RPC "no such entity". The SDK's PluginRpcCallError carries `code` "not_found" or, for a server
 * code it does not know ("thread_not_found", "project_not_found", …), `code` "unknown_error" + `serverCode`;
 * a BbHttpError arrives as code "<entity>_not_found" with message "HTTP 404: …". A 500 or transport
 * failure is not absence and must not pass.
 */
export const isNotFound = (cause: unknown): boolean => {
  if (typeof cause !== "object" || cause === null) return false;
  const err = cause as { code?: unknown; serverCode?: unknown; status?: unknown; statusCode?: unknown; message?: unknown };
  return isNotFoundCode(err.code) || isNotFoundCode(err.serverCode) || isHttp404(err);
};

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
export async function orMiss<T, F>(work: Promise<T>, fallback: F, expected: (cause: unknown) => boolean): Promise<T | F> {
  try {
    return await work;
  } catch (cause) {
    if (expected(cause)) return fallback;
    throw cause;
  }
}

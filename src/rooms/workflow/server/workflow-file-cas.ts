import { isFsAbsent } from "@lane-pilot/kit";

/** The byte cap above which a CAS base read refuses instead of silently working on a slice of the file. */
export const CAS_READ_CAP_BYTES = 2_000_000;

const FILE_ABSENT_CODES = new Set(["file_not_found", "host_file_not_found", "path_not_found"]);

/** File absence, and only file absence: a raw ENOENT, or the SDK's `not_found` / `unknown_error` code carrying a
 *  file-scoped serverCode. `project_not_found`, `thread_not_found`, 500s and transport failures still refuse. */
export function isMissingCasFile(cause: unknown): boolean {
  if (isFsAbsent(cause)) return true;
  if (!cause || typeof cause !== "object") return false;
  const error = cause as { code?: unknown; serverCode?: unknown };
  if (FILE_ABSENT_CODES.has(String(error.code ?? ""))) return true;
  return (error.code === "not_found" || error.code === "unknown_error") && FILE_ABSENT_CODES.has(String(error.serverCode ?? ""));
}

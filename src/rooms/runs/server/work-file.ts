import { getRun, getRunWriterHost, type LanePilotDatabase } from "../../storage";

/**
 * The window's door to a work file (SMA d_artifact): a bounded read of a file of the run's checkout by its relative
 * path. The path check carries the guarantee — no absolute paths, no «..», no .git/, no secret-looking names.
 */
export function workFilePathError(relativePath: string): string | null {
  const parts = relativePath.split("/");
  const base = parts[parts.length - 1] ?? "";
  if (relativePath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(relativePath)) return `work file refused: absolute path ${relativePath}`;
  if (parts.some((part) => part === "..")) return `work file refused: ${relativePath} escapes the checkout`;
  if (parts.includes(".git")) return `work file refused: ${relativePath} is inside .git`;
  if (/^\.env/i.test(base) || /\.pem$/i.test(base) || /key/i.test(base)) return `work file refused: ${relativePath} names a secret`;
  if (parts.some((part) => !part.length || part === ".")) return `work file refused: malformed path ${relativePath}`;
  return null;
}

type BoundedFile = { path: string; content: string; totalLines: number; lineStart: number; lineEnd: number; truncated: boolean; sizeBytes: number };
type HostCaller = { call(method: "readBoundedFile", input: Record<string, unknown>, opts: { hostId: string; timeoutMs: number }): Promise<BoundedFile> };

/** The read itself: the run's writer host and checkout, up to 200 lines from `offset`. */
export async function workFileRead(db: LanePilotDatabase, host: HostCaller, input: { runId: string; relativePath: string; offset?: number }): Promise<BoundedFile> {
  const refused = workFilePathError(input.relativePath);
  if (refused) throw new Error(refused);
  const run = getRun(db, input.runId);
  const hostId = run ? getRunWriterHost(db, input.runId) : null;
  if (!run?.writer_workspace_path || !hostId) throw new Error(`run ${input.runId} has no checkout to read from`);
  return await host.call("readBoundedFile", { requestedHostId: hostId, projectCwd: run.writer_workspace_path, relativePath: input.relativePath, offset: input.offset ?? 0, maxLines: 200 }, { hostId, timeoutMs: 15_000 });
}

import { secretPathHit } from "@lane-pilot/kit";
import { getRun, getRunWriterHost, type LanePilotDatabase } from "../../storage";

/**
 * The window's door to a work file (SMA d_artifact): a bounded read of a file of the run's checkout by its relative
 * path. The path check carries the guarantee — no absolute paths, no «..», no .git/, no secret-looking names.
 */
export function workFilePathError(relativePath: string): string | null {
  const parts = relativePath.split("/");
  if (relativePath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(relativePath)) return `work file refused: absolute path ${relativePath}`;
  if (parts.some((part) => part === "..")) return `work file refused: ${relativePath} escapes the checkout`;
  const secret = secretPathHit(relativePath);
  if (secret && "dir" in secret) return `work file refused: ${relativePath} is inside ${secret.dir}`;
  if (secret) return `work file refused: ${relativePath} names a secret`;
  if (parts.some((part) => !part.length || part === ".")) return `work file refused: malformed path ${relativePath}`;
  return null;
}

type BoundedFile = { path: string; content: string; totalLines: number; lineStart: number; lineEnd: number; truncated: boolean; sizeBytes: number };
type HostCaller = { call(method: "readBoundedFile", input: Record<string, unknown>, opts: { hostId: string; timeoutMs: number }): Promise<BoundedFile> };

/** The read itself: the run's writer host and checkout, up to 200 lines from `offset`. */
export async function workFileRead(db: LanePilotDatabase, host: HostCaller, input: { runId: string; projectId?: string; relativePath: string; offset?: number }): Promise<BoundedFile> {
  const refused = workFilePathError(input.relativePath);
  if (refused) throw new Error(refused);
  const run = getRun(db, input.runId);
  const hostId = run ? getRunWriterHost(db, input.runId) : null;
  if (!run?.writer_workspace_path || !hostId) throw new Error(`run ${input.runId} has no checkout to read from`);
  // A window that names a project may read only that project's runs.
  if (input.projectId && input.projectId !== run.project_id) throw new Error("work file refused: run does not belong to this project");
  const reply = await host.call("readBoundedFile", { requestedHostId: hostId, projectCwd: run.writer_workspace_path, relativePath: input.relativePath, offset: input.offset ?? 0, maxLines: 200 }, { hostId, timeoutMs: 15_000 });
  // Exactly the RPC's output fields: the host reply also carries schemaVersion, hostId, sha256 and more, which the strict schema rejects.
  const { path, content, totalLines, lineStart, lineEnd, truncated, sizeBytes } = reply;
  return { path, content, totalLines, lineStart, lineEnd, truncated, sizeBytes };
}

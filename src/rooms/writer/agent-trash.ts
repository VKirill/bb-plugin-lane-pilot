import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hashPath, lanePilotRoot } from "@lane-pilot/kit";
import { AGENT_TRASH_SOURCE } from "./agent-trash-source";

/** Writers, the live-folder restore and the shell guard name this path. (2026-10-29) not ~/.agents/bin from Claude Lane. */
export const AGENT_TRASH_RELATIVE = ".agents/lane-pilot/bin/agent-trash";

export function ownedAgentTrashPath(homeDir: string): string {
  return join(lanePilotRoot(homeDir), "bin", "agent-trash");
}

async function hashOrNull(path: string): Promise<string | null> {
  try { return (await hashPath(path)).sha256; }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Write the bundled agent-trash into the Lane Pilot-owned bin; newer bundled versions replace older copies.
 * The installer must call this next to applyInstalledGuard, including when the guard is already active.
 */
export async function materializeAgentTrash(input: { homeDir: string; moduleUrl: string; sourcePath?: string }): Promise<{ path: string; changed: boolean }> {
  const destination = ownedAgentTrashPath(input.homeDir);
  // BB delivers only host.mjs to a machine, without the lane-stack source tree.
  let content = Buffer.from(AGENT_TRASH_SOURCE, "utf8");
  if (input.sourcePath !== undefined) {
    const sourceInfo = await lstat(input.sourcePath);
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error(`agent-trash source is not a regular file: ${input.sourcePath}`);
    content = await readFile(input.sourcePath);
  }
  const sourceHash = createHash("sha256").update(content).digest("hex");
  const existing = await hashOrNull(destination);
  if (existing !== null) {
    const destinationInfo = await lstat(destination);
    if (!destinationInfo.isFile() || destinationInfo.isSymbolicLink()) {
      throw new Error(`Lane Pilot-owned agent-trash is not a regular file and was preserved: ${destination}`);
    }
    if (existing === sourceHash) {
      await chmod(destination, 0o755);
      return { path: destination, changed: false };
    }
    // Lane Pilot owns this file: a newer bundled version replaces it, else an upgrade would fail every install (2026-10-30).
    const next = `${destination}.${randomUUID()}.next`;
    await writeFile(next, content, { flag: "wx", mode: 0o755 });
    await chmod(next, 0o755);
    await rename(next, destination);
    return { path: destination, changed: true };
  }
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content, { flag: "wx", mode: 0o755 });
  await chmod(destination, 0o755);
  return { path: destination, changed: true };
}

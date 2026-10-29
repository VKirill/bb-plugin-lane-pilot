import { chmod, cp, lstat, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hashPath, lanePilotRoot, pluginRootFromModule } from "@lane-pilot/kit";

/** Writers, the live-folder restore and the shell guard name this path. (2026-10-29) not ~/.agents/bin from Claude Lane. */
export const AGENT_TRASH_RELATIVE = ".agents/lane-pilot/bin/agent-trash";

export function ownedAgentTrashPath(homeDir: string): string {
  return join(lanePilotRoot(homeDir), "bin", "agent-trash");
}

export function defaultAgentTrashSource(moduleUrl: string): string {
  return join(pluginRootFromModule(moduleUrl), "lane-stack/bin/agent-trash");
}

async function hashOrNull(path: string): Promise<string | null> {
  try { return (await hashPath(path)).sha256; }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Copy the bundled agent-trash into the Lane Pilot-owned bin (same rule as the guard: a diverged file is kept).
 * The installer must call this next to applyInstalledGuard, including when the guard is already active.
 */
export async function materializeAgentTrash(input: { homeDir: string; moduleUrl: string; sourcePath?: string }): Promise<{ path: string; changed: boolean }> {
  const source = input.sourcePath ?? defaultAgentTrashSource(input.moduleUrl);
  const destination = ownedAgentTrashPath(input.homeDir);
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error(`agent-trash source is not a regular file: ${source}`);
  const sourceHash = (await hashPath(source)).sha256;
  if (!sourceHash) throw new Error(`agent-trash source could not be hashed: ${source}`);
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
    const next = `${destination}.next`;
    await cp(source, next, { force: true });
    await chmod(next, 0o755);
    await rename(next, destination);
    return { path: destination, changed: true };
  }
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { errorOnExist: true, force: false });
  await chmod(destination, 0o755);
  return { path: destination, changed: true };
}

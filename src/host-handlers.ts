import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, readFile, readlink, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExperimentalHostRpcHandlers } from "@get-bb/plugin-sdk";
import { hostContract } from "./contracts";

function commandVersion(command: string): {present:boolean; version:string|null} {
  try {
    return { present:true, version:execFileSync(command, ["--version"], { encoding:"utf8", timeout:5000 }).trim() };
  } catch {
    return { present:false, version:null };
  }
}

async function hashFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export const detect: ExperimentalHostRpcHandlers<typeof hostContract>["detect"] = async (input) => {
  const installPath = join(homedir(), ".agents", "install.json");
  let sourceSha: string | null = null;
  let version: string | null = null;
  try {
    const value = JSON.parse(await readFile(installPath, "utf8")) as Record<string,unknown>;
    sourceSha = typeof value.source_sha === "string" ? value.source_sha : null;
    version = typeof value.version === "string" ? value.version : sourceSha;
  } catch { /* absent/invalid is reported, never repaired */ }
  return {
    hostId: process.env.BB_HOST_ID ?? input.requestedHostId,
    laneStack: { present:sourceSha !== null || version !== null, version, sourceSha },
    openCode: commandVersion("opencode"),
    workspace: { path:input.workspacePath, present:await stat(input.workspacePath).then(() => true, () => false) },
  };
};

export const snapshotDryRun: ExperimentalHostRpcHandlers<typeof hostContract>["snapshotDryRun"] = async (input) => ({
  hostId: process.env.BB_HOST_ID ?? input.requestedHostId,
  entries: await Promise.all(input.paths.map(async (path) => {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) return { path, kind:"symlink" as const, sha256:null, symlinkTarget:await readlink(path) };
      if (info.isFile()) return { path, kind:"file" as const, sha256:await hashFile(path), symlinkTarget:null };
      if (info.isDirectory()) return { path, kind:"directory" as const, sha256:null, symlinkTarget:null };
      return { path, kind:"other" as const, sha256:null, symlinkTarget:null };
    } catch {
      return { path, kind:"missing" as const, sha256:null, symlinkTarget:null };
    }
  })),
});

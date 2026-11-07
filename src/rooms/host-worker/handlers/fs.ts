import { lstat, readFile, readlink, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { ExperimentalHostRpcHandlers } from "@get-bb/plugin-sdk";
import { hostContract } from "../../contracts";
import { readBoundedWorkspaceFile, sha256Hex } from "@lane-pilot/kit";

async function hashFile(path: string): Promise<string> {
  return sha256Hex(await readFile(path));
}

export const readOpenCodeTelemetry: ExperimentalHostRpcHandlers<typeof hostContract>["readOpenCodeTelemetry"] = async (input) => {
  const rootInfo = await lstat(input.projectCwd);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("telemetry project root must be a real directory");
  const rootReal = await realpath(input.projectCwd);
  const normalized = input.relativePath.replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (isAbsolute(input.relativePath) || input.relativePath.includes("\\") || normalized.split("/").includes("..")
    || segments.some((segment) => !segment || segment === ".") || /^[A-Za-z]:/.test(normalized)
    || !normalized.endsWith(".jsonl") || normalized.length > 512) {
    throw new Error("telemetry path must be a bounded project-relative .jsonl path");
  }
  const fullPath = join(rootReal, normalized);
  let cursor = rootReal;
  for (const segment of normalized.split("/")) {
    cursor = join(cursor, segment);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new Error("telemetry path cannot traverse a symlink");
    if (cursor !== fullPath && !info.isDirectory()) throw new Error("telemetry path parent must be a directory");
    if (cursor === fullPath && !info.isFile()) throw new Error("telemetry path must be a regular file");
  }
  const actual = await realpath(fullPath);
  const rel = relative(rootReal, actual);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("telemetry path escaped the task workspace");
  const info = await lstat(actual);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("telemetry path must be a regular file");
  if (info.size > 262144) throw new Error("telemetry log exceeds 262144 bytes");
  const bytes = await readFile(actual);
  let content: string;
  try { content = new TextDecoder("utf-8", { fatal:true }).decode(bytes); }
  catch { throw new Error("telemetry log is not valid UTF-8"); }
  return { hostId:process.env.BB_HOST_ID ?? input.requestedHostId, relativePath:normalized,
    size:bytes.byteLength, sha256:sha256Hex(bytes), content };
};

export const readBoundedFile: ExperimentalHostRpcHandlers<typeof hostContract>["readBoundedFile"] = async (input) => {
  const workerHost = process.env.BB_HOST_ID?.trim();
  if (workerHost && workerHost !== input.requestedHostId) {
    throw new Error("lane_pilot_read_host_mismatch");
  }
  return readBoundedWorkspaceFile({
    hostId: workerHost || input.requestedHostId,
    projectCwd: input.projectCwd,
    relativePath: input.relativePath,
    offset: input.offset,
    maxLines: input.maxLines,
  });
};

const LIST_FOLDER_MAX = 500;

/** The file names in each folder, for the contract lint's tests next to owned code («shoot.ts» → «__tests__/shoot-seo-audit.test.ts»). */
export const listFolders: ExperimentalHostRpcHandlers<typeof hostContract>["listFolders"] = async (input) => ({
  hostId: process.env.BB_HOST_ID ?? input.requestedHostId,
  entries: await Promise.all(input.paths.map(async (path) => {
    const names = await readdir(path, { withFileTypes:true })
      .then((entries) => entries.filter((entry) => entry.isFile() || entry.isSymbolicLink()).map((entry) => entry.name).sort(), () => [] as string[]);
    return { path, names:names.slice(0, LIST_FOLDER_MAX), truncated:names.length > LIST_FOLDER_MAX };
  })),
});

export const snapshotDryRun: ExperimentalHostRpcHandlers<typeof hostContract>["snapshotDryRun"] = async (input) => ({
  hostId: process.env.BB_HOST_ID ?? input.requestedHostId,
  entries: await Promise.all(input.paths.map(async (path) => {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        const target = await stat(path).then((followed) => followed.isFile() ? "file" as const : followed.isDirectory() ? "directory" as const : "other" as const, () => "missing" as const);
        return { path, kind:"symlink" as const, sha256:null, symlinkTarget:await readlink(path), targetKind:target };
      }
      if (info.isFile()) return { path, kind:"file" as const, sha256:await hashFile(path), symlinkTarget:null };
      if (info.isDirectory()) return { path, kind:"directory" as const, sha256:null, symlinkTarget:null };
      return { path, kind:"other" as const, sha256:null, symlinkTarget:null };
    } catch {
      return { path, kind:"missing" as const, sha256:null, symlinkTarget:null };
    }
  })),
});

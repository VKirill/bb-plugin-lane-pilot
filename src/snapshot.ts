import { copyFile, cp, link, lstat, mkdir, readFile, readdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { EXTERNAL_OPS, EXTERNAL_OPS_WARNING } from "./constants";
import { hashPath } from "./hash";
import { MANIFEST_ROWS, type ManifestRow } from "./manifest";
import { expandHomePath, lanePilotRoot, resolveHome } from "./paths";
import { observeExternalOps } from "./external-ops";

export type ManifestEntry = {
  id: string;
  path: string;
  kind: ManifestRow["kind"];
  existedBefore: boolean;
  sha256Before: string | null;
  sha256After: string | null;
  symlinkTarget: string | null;
  externalOpsBefore: string | null;
  externalOpsAfter: string | null;
};

export type SnapshotResult = {
  snapshotPath: string;
  manifestPath: string;
  entries: ManifestEntry[];
};

export class SnapshotReadError extends Error {
  readonly path: string;
  readonly causeCode: string | null;

  constructor(path: string, cause: unknown) {
    const code = errorCode(cause);
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`cannot snapshot ${path}: ${code ?? "error"} ${message}`);
    this.name = "SnapshotReadError";
    this.path = path;
    this.causeCode = code;
  }
}

function errorCode(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return null;
}

function isEnoent(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function copyName(path: string, home: string): string {
  const expanded = expandHomePath(path, home);
  if (expanded.startsWith(home)) {
    const rel = relative(home, expanded);
    return rel.length > 0 ? rel : "_home";
  }
  return expanded.replaceAll("/", "_").replace(/^_/, "");
}

async function copyEntry(src: string, dest: string, kind: ManifestRow["kind"]): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  if (kind === "symlink") {
    await symlink(await readlink(src), dest);
    return;
  }
  await cp(src, dest, { recursive: true, dereference: false, errorOnExist: false, force: true });
}

export async function takeSnapshot(input: {
  homeDir?: string;
  threadStoragePath?: string;
  additionalPaths?: string[];
  includeManifest?: boolean;
}): Promise<SnapshotResult> {
  const home = resolveHome(input.homeDir);
  const ts = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
  const snapshotPath = input.threadStoragePath
    ? join(input.threadStoragePath, "tmp", `lane-pilot-install-snapshot-${ts}`)
    : join(lanePilotRoot(home), "snapshots", ts);
  await mkdir(snapshotPath, { recursive: true });
  try {
    const externalBefore = input.includeManifest === false ? {} : await observeExternalOps(home);
    const entries: ManifestEntry[] = [];
    for (const row of input.includeManifest === false ? [] : MANIFEST_ROWS) {
      if (row.kind === "external") {
        entries.push({
          id: row.id,
          path: row.path,
          kind: row.kind,
          existedBefore: false,
          sha256Before: null,
          sha256After: null,
          symlinkTarget: null,
          externalOpsBefore: externalBefore[row.path] ?? null,
          externalOpsAfter: null,
        });
        continue;
      }
      const abs = expandHomePath(row.path, home);
      try {
        await lstat(abs);
      } catch (error) {
        if (isEnoent(error)) {
          entries.push({
            id: row.id,
            path: abs,
            kind: row.kind,
            existedBefore: false,
            sha256Before: null,
            sha256After: null,
            symlinkTarget: null,
            externalOpsBefore: null,
            externalOpsAfter: null,
          });
          continue;
        }
        throw new SnapshotReadError(abs, error);
      }
      let sha256Before: string | null = null;
      let symlinkTarget: string | null = null;
      try {
        const hashed = await hashPath(abs);
        sha256Before = hashed.sha256;
        symlinkTarget = hashed.symlinkTarget;
        await copyEntry(abs, join(snapshotPath, copyName(row.path, home)), row.kind);
      } catch (error) {
        throw new SnapshotReadError(abs, error);
      }
      entries.push({
        id: row.id,
        path: abs,
        kind: row.kind,
        existedBefore: true,
        sha256Before,
        sha256After: null,
        symlinkTarget,
        externalOpsBefore: null,
        externalOpsAfter: null,
      });
    }
    const recordedPaths = new Set(entries.map((entry) => entry.path));
    for (const path of input.additionalPaths ?? []) {
      const abs = resolve(path);
      if (recordedPaths.has(abs)) continue;
      let info;
      try {
        info = await lstat(abs);
      } catch (error) {
        if (!isEnoent(error)) throw new SnapshotReadError(abs, error);
        entries.push({
          id: `additional-${entries.length}`,
          path: abs,
          kind: "file",
          existedBefore: false,
          sha256Before: null,
          sha256After: null,
          symlinkTarget: null,
          externalOpsBefore: null,
          externalOpsAfter: null,
        });
        recordedPaths.add(abs);
        continue;
      }
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new SnapshotReadError(abs, new Error("additional snapshot path is not a regular file"));
      }
      try {
        const hashed = await hashPath(abs);
        await copyEntry(abs, join(snapshotPath, copyName(abs, home)), "file");
        entries.push({
          id: `additional-${entries.length}`,
          path: abs,
          kind: "file",
          existedBefore: true,
          sha256Before: hashed.sha256,
          sha256After: null,
          symlinkTarget: null,
          externalOpsBefore: null,
          externalOpsAfter: null,
        });
        recordedPaths.add(abs);
      } catch (error) {
        throw new SnapshotReadError(abs, error);
      }
    }
    const manifest = {
      schemaVersion: 1,
      home,
      createdAt: new Date().toISOString(),
      externalOpsWarning: EXTERNAL_OPS_WARNING,
      externalOps: EXTERNAL_OPS,
      entries,
    };
    const manifestPath = join(snapshotPath, "manifest.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return { snapshotPath, manifestPath, entries };
  } catch (error) {
    await rm(snapshotPath, { recursive: true, force: true });
    throw error;
  }
}

export async function finalizeSnapshotAfter(
  snapshot: SnapshotResult,
  homeDir?: string,
): Promise<ManifestEntry[]> {
  const home = resolveHome(homeDir);
  const externalAfter = snapshot.entries.some((entry) => entry.kind === "external")
    ? await observeExternalOps(home)
    : {};
  for (const entry of snapshot.entries) {
    if (entry.kind === "external") {
      entry.externalOpsAfter = externalAfter[entry.path] ?? null;
      continue;
    }
    try {
      const hashed = await hashPath(entry.path);
      entry.sha256After = hashed.sha256;
    } catch {
      entry.sha256After = null;
    }
  }
  const previous = JSON.parse(await readFile(snapshot.manifestPath, "utf8")) as Record<string, unknown>;
  await writeFile(snapshot.manifestPath, `${JSON.stringify({
    ...previous,
    entries: snapshot.entries,
  }, null, 2)}\n`);
  return snapshot.entries;
}

export async function rollbackSnapshot(snapshotPath: string): Promise<{
  restored: string[];
  removed: string[];
  conflicts: Array<{ path: string; expectedSha256: string | null; actualSha256: string | null; reason: string }>;
}> {
  const manifestPath = join(snapshotPath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    home: string;
    entries: ManifestEntry[];
  };
  const restored: string[] = [];
  const removed: string[] = [];
  const conflicts: Array<{ path: string; expectedSha256: string | null; actualSha256: string | null; reason: string }> = [];
  const currentSha = async (path: string): Promise<string | null> => {
    try { return (await hashPath(path)).sha256; }
    catch (error) {
      if (isEnoent(error)) return null;
      throw error;
    }
  };
  const restoreNoReplace = async (source: string, destination: string): Promise<void> => {
    const info = await lstat(source);
    await mkdir(dirname(destination), { recursive: true });
    if (info.isSymbolicLink()) {
      await symlink(await readlink(source), destination);
      return;
    }
    if (info.isDirectory()) {
      await mkdir(destination, { mode: info.mode & 0o777 });
      const entries = await readdir(source, { withFileTypes: true });
      for (const child of entries) await restoreNoReplace(join(source, child.name), join(destination, child.name));
      return;
    }
    if (!info.isFile()) throw new Error(`unsupported snapshot entry type at ${source}`);
    const temporary = `${destination}.lane-pilot-restore-${randomUUID()}`;
    try {
      await copyFile(source, temporary);
      await link(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  };
  const preserveQuarantine = async (quarantine: string, original: string): Promise<void> => {
    try {
      if (await currentSha(original) !== null) return;
      await restoreNoReplace(quarantine, original);
    } catch {
      // Keep the only remaining copy in quarantine if the original path was recreated.
    }
  };
  for (const entry of manifest.entries) {
    if (entry.kind === "external") continue;
    const actual = await currentSha(entry.path);
    if (actual === entry.sha256Before) continue;
    if (entry.sha256After === null || actual !== entry.sha256After) {
      conflicts.push({
        path: entry.path,
        expectedSha256: entry.sha256After,
        actualSha256: actual,
        reason: entry.sha256After === null
          ? "Snapshot has no post-operation hash; changed path was preserved."
          : "Path changed after the snapshot operation; concurrent content was preserved.",
      });
      continue;
    }

    const quarantine = `${entry.path}.lane-pilot-rollback-${randomUUID()}`;
    try {
      await rename(entry.path, quarantine);
    } catch (error) {
      conflicts.push({ path: entry.path, expectedSha256: entry.sha256After, actualSha256: await currentSha(entry.path), reason: `Could not claim path for CAS rollback: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    const quarantinedSha = await currentSha(quarantine);
    if (quarantinedSha !== entry.sha256After) {
      await preserveQuarantine(quarantine, entry.path);
      conflicts.push({ path: entry.path, expectedSha256: entry.sha256After, actualSha256: quarantinedSha, reason: "Path changed while rollback claimed it; quarantined content was preserved." });
      continue;
    }

    if (entry.existedBefore) {
      const copy = join(snapshotPath, copyName(entry.path, manifest.home));
      try {
        await restoreNoReplace(copy, entry.path);
        const restoredSha = await currentSha(entry.path);
        if (restoredSha !== entry.sha256Before) {
          conflicts.push({ path: entry.path, expectedSha256: entry.sha256Before, actualSha256: restoredSha, reason: "A concurrent write raced snapshot restoration; the quarantined post-operation copy was retained." });
          continue;
        }
        restored.push(entry.path);
      } catch (error) {
        await preserveQuarantine(quarantine, entry.path);
        conflicts.push({ path: entry.path, expectedSha256: entry.sha256Before, actualSha256: await currentSha(entry.path), reason: `Snapshot restoration did not replace an existing path: ${error instanceof Error ? error.message : String(error)}` });
        continue;
      }
    } else {
      removed.push(entry.path);
    }

    if (await currentSha(quarantine) === entry.sha256After) {
      await rm(quarantine, { recursive: true, force: true });
    } else {
      conflicts.push({ path: entry.path, expectedSha256: entry.sha256After, actualSha256: await currentSha(quarantine), reason: "Quarantined content changed during rollback and was retained." });
    }
  }
  return { restored, removed, conflicts };
}

export async function verifyRollback(snapshotPath: string): Promise<{
  ok: boolean;
  mismatches: Array<{ path: string; expected: string | null; actual: string | null }>;
}> {
  const manifest = JSON.parse(await readFile(join(snapshotPath, "manifest.json"), "utf8")) as {
    entries: ManifestEntry[];
  };
  const mismatches: Array<{ path: string; expected: string | null; actual: string | null }> = [];
  for (const entry of manifest.entries) {
    if (entry.kind === "external") continue;
    if (entry.existedBefore) {
      let actual: string | null = null;
      try {
        actual = (await hashPath(entry.path)).sha256;
      } catch (error) {
        if (isEnoent(error)) actual = null;
        else actual = "unreadable";
      }
      if (actual !== entry.sha256Before) {
        mismatches.push({ path: entry.path, expected: entry.sha256Before, actual });
      }
    } else {
      try {
        await lstat(entry.path);
        mismatches.push({ path: entry.path, expected: null, actual: "exists" });
      } catch (error) {
        if (!isEnoent(error)) mismatches.push({ path: entry.path, expected: null, actual: "unreadable" });
      }
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

import { cp, lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
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
}): Promise<SnapshotResult> {
  const home = resolveHome(input.homeDir);
  const ts = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
  const snapshotPath = input.threadStoragePath
    ? join(input.threadStoragePath, "tmp", `lane-pilot-install-snapshot-${ts}`)
    : join(lanePilotRoot(home), "snapshots", ts);
  await mkdir(snapshotPath, { recursive: true });
  try {
    const externalBefore = await observeExternalOps(home);
    const entries: ManifestEntry[] = [];
    for (const row of MANIFEST_ROWS) {
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
  const externalAfter = await observeExternalOps(home);
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
}> {
  const manifestPath = join(snapshotPath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    home: string;
    entries: ManifestEntry[];
  };
  const restored: string[] = [];
  const removed: string[] = [];
  for (const entry of manifest.entries) {
    if (entry.kind === "external") continue;
    if (entry.existedBefore) {
      const copy = join(snapshotPath, copyName(entry.path, manifest.home));
      await rm(entry.path, { recursive: true, force: true });
      await mkdir(dirname(entry.path), { recursive: true });
      await copyEntry(copy, entry.path, entry.kind);
      restored.push(entry.path);
    } else {
      await rm(entry.path, { recursive: true, force: true });
      removed.push(entry.path);
    }
  }
  return { restored, removed };
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
      } catch {
        actual = null;
      }
      if (actual !== entry.sha256Before) {
        mismatches.push({ path: entry.path, expected: entry.sha256Before, actual });
      }
    } else {
      try {
        await lstat(entry.path);
        mismatches.push({ path: entry.path, expected: null, actual: "exists" });
      } catch {
        /* absent as required */
      }
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

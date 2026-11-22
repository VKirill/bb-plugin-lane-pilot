import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { redactKnown, sha256Hex } from "@lane-pilot/kit";

export const SKILL_BUNDLE_ID = /^[a-z][a-z0-9-]{1,47}$/;
export const ALLOWED_SKILL_BUNDLE_FILE =
  /^(?:SKILL\.md|references\/[a-z0-9][a-z0-9._-]{0,79}\.md)$/i;
export const SKILL_MD_MAX_BYTES = 8_192; // SKILL.md must be strictly < 8_192 UTF-8 bytes
export const SKILL_MD_MAX_LINES = 500; // SKILL.md must be <= 500 lines
export const SKILL_REF_MAX_BYTES = 32_768; // references/*.md must be <= 32_768 UTF-8 bytes

export type SkillBundleFile = { path: string; text: string };
export type StoredSkillBundleFile = { path: string; text: string; sha256: string };
export type SkillBundleReadResult = { exists: boolean; skillId: string; dirPath: string; files: StoredSkillBundleFile[]; bundleSha256: string | null };
export type SkillBundleWriteResult = {
  status: "applied" | "conflict" | "invalid";
  skillId: string;
  dirPath: string;
  beforeFiles: StoredSkillBundleFile[];
  afterFiles: StoredSkillBundleFile[];
  beforeSha256: string | null;
  afterSha256: string | null;
  reason: string | null;
};
export type SkillFilesOptions = { log?: (message: string) => void };

type LogLevel = "debug" | "info" | "warn" | "error" | "silent";
const LOG_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };

class SymlinkForbiddenError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`symlink forbidden: ${path}`);
    this.name = "SymlinkForbiddenError";
    this.path = path;
  }
}

function emitLog(options: SkillFilesOptions | undefined, level: "DEBUG" | "INFO" | "WARN", event: string, payload: Record<string, unknown>): void {
  if (!options?.log) return;
  const raw = process.env.LOG_LEVEL?.trim().toLowerCase();
  const effective: LogLevel = raw && raw in LOG_RANK ? (raw as LogLevel) : "debug";
  const rank = level === "DEBUG" ? 0 : level === "INFO" ? 1 : 2;
  if (rank >= LOG_RANK[effective]) options.log(`${level} [workflowEngine.skillFiles] ${event} ${redactKnown(JSON.stringify(payload))}`);
}

const invalidWrite = (skillId: string, dirPath: string, reason: string): SkillBundleWriteResult => ({
  status: "invalid", skillId, dirPath, beforeFiles: [], afterFiles: [], beforeSha256: null, afterSha256: null, reason,
});

async function assertNotSymlink(targetPath: string): Promise<Stats | null> {
  try {
    const st = await lstat(targetPath);
    if (st.isSymbolicLink()) throw new SymlinkForbiddenError(targetPath);
    return st;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
}

async function writeFileAtomic(targetPath: string, text: string): Promise<void> {
  const tempPath = `${targetPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, text, { mode: 0o644, flag: "wx" });
    await rename(tempPath, targetPath);
  } finally {
    await rm(tempPath, { force: true });
  }
}

async function removeEmptyDirBestEffort(dirPath: string): Promise<void> {
  try {
    if ((await readdir(dirPath)).length === 0) await rmdir(dirPath);
  } catch { /* Best-effort cleanup of empty references/ directory. */ }
}

async function removeLeftoverMarkdown(dir: string, prefix: string, keep: Set<string>): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
    throw cause;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || !entry.name.endsWith(".md")) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!keep.has(rel) && entry.isFile()) await rm(join(dir, entry.name), { force: true });
  }
}

async function readSkillBundleInternal(skillsRoot: string, skillId: string, options?: SkillFilesOptions): Promise<SkillBundleReadResult> {
  const dirPath = join(skillsRoot, skillId);
  await assertNotSymlink(skillsRoot);
  if (!(await assertNotSymlink(dirPath))) {
    emitLog(options, "DEBUG", "read_bundle", { skillId, dirPath, exists: false, fileCount: 0, bundleSha256: null });
    return { exists: false, skillId, dirPath, files: [], bundleSha256: null };
  }

  const rawFiles: StoredSkillBundleFile[] = [];
  const skillMdPath = join(dirPath, "SKILL.md");
  if ((await assertNotSymlink(skillMdPath))?.isFile()) {
    const text = await readFile(skillMdPath, "utf8");
    rawFiles.push({ path: "SKILL.md", text, sha256: sha256Hex(text) });
  }

  const refsDir = join(dirPath, "references");
  if ((await assertNotSymlink(refsDir))?.isDirectory()) {
    for (const entry of await readdir(refsDir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || !entry.name.endsWith(".md")) continue;
      const entryPath = join(refsDir, entry.name);
      if ((await assertNotSymlink(entryPath))?.isFile()) {
        const text = await readFile(entryPath, "utf8");
        rawFiles.push({ path: `references/${entry.name}`, text, sha256: sha256Hex(text) });
      }
    }
  }

  const files = sortSkillBundleFiles(rawFiles);
  const bundleSha256 = files.length > 0 ? computeSkillBundleSha256(files) : null;
  const exists = files.length > 0;
  emitLog(options, "DEBUG", "read_bundle", { skillId, dirPath, exists, fileCount: files.length, paths: files.map((f) => f.path), bundleSha256 });
  return { exists, skillId, dirPath, files, bundleSha256 };
}

async function readBeforeAndCheckTargets(
  skillsRoot: string,
  skillId: string,
  normalized: readonly SkillBundleFile[] | null,
  options?: SkillFilesOptions,
): Promise<{ ok: true; before: SkillBundleReadResult } | { ok: false; result: SkillBundleWriteResult }> {
  const dirPath = join(skillsRoot, skillId);
  try {
    const before = await readSkillBundleInternal(skillsRoot, skillId, options);
    if (normalized) for (const file of normalized) await assertNotSymlink(join(dirPath, file.path));
    return { ok: true, before };
  } catch (cause) {
    if (cause instanceof SymlinkForbiddenError) {
      emitLog(options, "WARN", "invalid_path_or_size", { skillId, dirPath, reason: "symlink_forbidden", path: cause.path });
      return { ok: false, result: invalidWrite(skillId, dirPath, "symlink_forbidden") };
    }
    throw cause;
  }
}

async function applyBundleFiles(
  dirPath: string,
  normalized: readonly SkillBundleFile[],
  beforeFiles: readonly StoredSkillBundleFile[],
  pruneLeftovers: boolean,
): Promise<{ afterFiles: StoredSkillBundleFile[]; afterSha256: string }> {
  await mkdir(dirPath, { recursive: true });
  if (normalized.some((f) => f.path.startsWith("references/"))) await mkdir(join(dirPath, "references"), { recursive: true });
  for (const file of normalized) await writeFileAtomic(join(dirPath, file.path), file.text);

  const keep = new Set(normalized.map((f) => f.path));
  for (const prev of beforeFiles) if (!keep.has(prev.path)) await rm(join(dirPath, prev.path), { force: true });
  if (pruneLeftovers) {
    await removeLeftoverMarkdown(dirPath, "", keep);
    await removeLeftoverMarkdown(join(dirPath, "references"), "references", keep);
  }
  await removeEmptyDirBestEffort(join(dirPath, "references"));

  const afterFiles = normalized.map((f) => ({ path: f.path, text: f.text, sha256: sha256Hex(f.text) }));
  return { afterFiles, afterSha256: computeSkillBundleSha256(afterFiles) };
}

/** Returns the global companion skills directory (`~/.bb/skills`). */
export function globalSkillsDir(home = homedir()): string {
  return join(home, ".bb", "skills");
}

/** Lists valid companion skill directory slugs directly under `skillsRoot` (excluding symlinks, best-effort). */
export async function listSkillBundleIds(skillsRoot: string): Promise<string[]> {
  try {
    if (!(await assertNotSymlink(skillsRoot))?.isDirectory()) return [];
    const ids: string[] = [];
    for (const entry of await readdir(skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !SKILL_BUNDLE_ID.test(entry.name)) continue;
      if ((await assertNotSymlink(join(skillsRoot, entry.name)))?.isDirectory()) ids.push(entry.name);
    }
    return ids.sort();
  } catch {
    return [];
  }
}

/** Orders `SKILL.md` first, followed by remaining paths sorted lexicographically. */
export function sortSkillBundleFiles<T extends { path: string }>(files: readonly T[]): T[] {
  return [...files].sort((a, b) => (a.path === b.path ? 0 : a.path === "SKILL.md" ? -1 : b.path === "SKILL.md" ? 1 : a.path.localeCompare(b.path)));
}

/** Validates skill bundle identifier, file paths, byte/line budgets, and returns normalized sorted files. */
export function validateSkillBundleFiles(
  skillId: string,
  files: readonly SkillBundleFile[],
): { ok: true; normalized: SkillBundleFile[] } | { ok: false; reason: string } {
  if (!SKILL_BUNDLE_ID.test(skillId)) return { ok: false, reason: "invalid_skill_id" };
  if (files.length === 0) return { ok: false, reason: "empty_bundle" };

  const seen = new Set<string>();
  const clean: SkillBundleFile[] = [];
  for (const file of files) {
    if (typeof file.path !== "string" || typeof file.text !== "string") return { ok: false, reason: "invalid_file_entry" };
    if (file.path.includes("\\") || file.path.includes("..") || file.path.startsWith("/") || !ALLOWED_SKILL_BUNDLE_FILE.test(file.path)) {
      return { ok: false, reason: `invalid_file_path:${file.path}` };
    }
    if (seen.has(file.path)) return { ok: false, reason: `duplicate_file_path:${file.path}` };
    seen.add(file.path);

    if (file.path === "SKILL.md") {
      if (!file.text.trim()) return { ok: false, reason: "empty_skill_md" };
      if (Buffer.byteLength(file.text, "utf8") >= SKILL_MD_MAX_BYTES) return { ok: false, reason: "skill_md_too_large" };
      if (file.text.split("\n").length > SKILL_MD_MAX_LINES) return { ok: false, reason: "skill_md_too_many_lines" };
    } else {
      if (!file.text.trim()) return { ok: false, reason: "empty_reference_file" };
      if (Buffer.byteLength(file.text, "utf8") > SKILL_REF_MAX_BYTES) return { ok: false, reason: `reference_file_too_large:${file.path}` };
    }
    clean.push({ path: file.path, text: file.text });
  }
  if (!seen.has("SKILL.md")) return { ok: false, reason: "missing_skill_md" };
  return { ok: true, normalized: sortSkillBundleFiles(clean) };
}

/** Computes a deterministic SHA-256 digest over a sorted skill bundle's paths and file contents. */
export function computeSkillBundleSha256(files: readonly SkillBundleFile[]): string {
  return sha256Hex(sortSkillBundleFiles(files).map((f) => `${f.path}:${sha256Hex(f.text)}`).join("\n"));
}

/** Reads a global companion skill bundle from `<skillsRoot>/<skillId>` while enforcing symlink safety. */
export async function readSkillBundle(skillsRoot: string, skillId: string, options?: SkillFilesOptions): Promise<SkillBundleReadResult> {
  if (!SKILL_BUNDLE_ID.test(skillId)) throw new Error(`invalid skill id: ${skillId}`);
  const dirPath = join(skillsRoot, skillId);
  try {
    return await readSkillBundleInternal(skillsRoot, skillId, options);
  } catch (cause) {
    if (cause instanceof SymlinkForbiddenError) {
      emitLog(options, "WARN", "invalid_path_or_size", { skillId, dirPath, reason: "symlink_forbidden", path: cause.path });
    }
    throw cause;
  }
}

/** Atomically writes a skill bundle when its current on-disk SHA-256 matches `expectedBundleSha256`. */
export async function casWriteSkillBundle(
  skillsRoot: string,
  skillId: string,
  files: readonly SkillBundleFile[],
  expectedBundleSha256: string | null,
  options?: SkillFilesOptions,
): Promise<SkillBundleWriteResult> {
  const dirPath = join(skillsRoot, skillId);
  const validation = validateSkillBundleFiles(skillId, files);
  if (!validation.ok) {
    emitLog(options, "WARN", "invalid_path_or_size", { skillId, dirPath, reason: validation.reason });
    return invalidWrite(skillId, dirPath, validation.reason);
  }

  const checked = await readBeforeAndCheckTargets(skillsRoot, skillId, validation.normalized, options);
  if (!checked.ok) return checked.result;
  const { before } = checked;

  if (before.bundleSha256 !== expectedBundleSha256) {
    const reason = before.bundleSha256 === null ? "bundle_absent" : expectedBundleSha256 === null ? "bundle_already_exists" : "bundle_sha256_mismatch";
    emitLog(options, "WARN", "cas_conflict", { skillId, dirPath, expectedBundleSha256, actualBundleSha256: before.bundleSha256, reason });
    return { status: "conflict", skillId, dirPath, beforeFiles: before.files, afterFiles: before.files, beforeSha256: before.bundleSha256, afterSha256: null, reason };
  }

  const { afterFiles, afterSha256 } = await applyBundleFiles(dirPath, validation.normalized, before.files, false);
  emitLog(options, "INFO", "cas_applied", { skillId, dirPath, beforeSha256: before.bundleSha256, afterSha256, fileCount: afterFiles.length, paths: afterFiles.map((f) => f.path) });
  return { status: "applied", skillId, dirPath, beforeFiles: before.files, afterFiles, beforeSha256: before.bundleSha256, afterSha256, reason: null };
}

/** Restores `<skillsRoot>/<skillId>` to a captured snapshot (or removes the directory if the snapshot is empty). */
export async function restoreSkillBundleSnapshot(
  skillsRoot: string,
  skillId: string,
  snapshotFiles: readonly SkillBundleFile[],
  options?: SkillFilesOptions,
): Promise<SkillBundleWriteResult> {
  const dirPath = join(skillsRoot, skillId);
  if (!SKILL_BUNDLE_ID.test(skillId)) {
    emitLog(options, "WARN", "invalid_path_or_size", { skillId, dirPath, reason: "invalid_skill_id" });
    return invalidWrite(skillId, dirPath, "invalid_skill_id");
  }

  let normalized: SkillBundleFile[] | null = null;
  if (snapshotFiles.length > 0) {
    const validation = validateSkillBundleFiles(skillId, snapshotFiles);
    if (!validation.ok) {
      emitLog(options, "WARN", "invalid_path_or_size", { skillId, dirPath, reason: validation.reason });
      return invalidWrite(skillId, dirPath, validation.reason);
    }
    normalized = validation.normalized;
  }

  const checked = await readBeforeAndCheckTargets(skillsRoot, skillId, normalized, options);
  if (!checked.ok) return checked.result;
  const { before } = checked;

  if (!normalized) {
    await rm(dirPath, { recursive: true, force: true });
    emitLog(options, "INFO", "snapshot_restored", { skillId, dirPath, beforeSha256: before.bundleSha256, afterSha256: null, removedDir: true, fileCount: 0 });
    return { status: "applied", skillId, dirPath, beforeFiles: before.files, afterFiles: [], beforeSha256: before.bundleSha256, afterSha256: null, reason: null };
  }

  const { afterFiles, afterSha256 } = await applyBundleFiles(dirPath, normalized, before.files, true);
  emitLog(options, "INFO", "snapshot_restored", { skillId, dirPath, beforeSha256: before.bundleSha256, afterSha256, removedDir: false, fileCount: afterFiles.length, paths: afterFiles.map((f) => f.path) });
  return { status: "applied", skillId, dirPath, beforeFiles: before.files, afterFiles, beforeSha256: before.bundleSha256, afterSha256, reason: null };
}

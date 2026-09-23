import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defaultGuardSource } from "./paths";
import { hashPath } from "./hash";

export type GuardAppliedFile = { path: string; sha256Before: string | null; sha256After: string };

async function hashOrNull(path: string): Promise<string | null> {
  try { return (await hashPath(path)).sha256; }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function copyOwnedFile(source: string, destination: string): Promise<GuardAppliedFile | null> {
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error(`guard source is not a regular file: ${source}`);
  const sourceHash = (await hashPath(source)).sha256;
  if (!sourceHash) throw new Error(`guard source could not be hashed: ${source}`);
  const existing = await hashOrNull(destination);
  if (existing !== null) {
    const destinationInfo = await lstat(destination);
    if (!destinationInfo.isFile() || destinationInfo.isSymbolicLink() || existing !== sourceHash) {
      throw new Error(`owned guard target has diverged and was preserved: ${destination}`);
    }
    return null;
  }

  await mkdir(dirname(destination), { recursive: true });
  try {
    await cp(source, destination, { errorOnExist: true, force: false });
  } catch (error) {
    if (await hashOrNull(destination) === sourceHash) return null;
    throw error;
  }
  return { path: destination, sha256Before: null, sha256After: sourceHash };
}

async function replaceSettingCas(path: string, from: RegExp, replacement: string): Promise<GuardAppliedFile | null> {
  let raw: string;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Claude workspace settings are not a regular file: ${path}`);
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  const next = raw.replace(from, () => replacement);
  if (next === raw) return null;

  const previousHash = (await hashPath(path)).sha256;
  if (!previousHash) throw new Error(`Claude workspace settings could not be hashed: ${path}`);
  const settings = await stat(path);
  const temporary = `${path}.lane-pilot-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, next, { mode: settings.mode & 0o777 });
    if (await readFile(path, "utf8") !== raw) throw new Error(`Claude workspace settings changed during guard update; CAS conflict: ${path}`);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  const afterHash = (await hashPath(path)).sha256;
  if (!afterHash) throw new Error(`Claude workspace settings could not be hashed after guard update: ${path}`);
  return { path, sha256Before: previousHash, sha256After: afterHash };
}

export async function applyInstalledGuard(input: {
  homeDir: string;
  guardSourcePath?: string;
  moduleUrl?: string;
  pmWorkspacePath?: string;
}): Promise<{ guardPath: string; settingsPath: string | null; filesChanged: GuardAppliedFile[] }> {
  const source = input.guardSourcePath
    ?? (input.moduleUrl ? defaultGuardSource(input.moduleUrl) : "");
  if (!source) throw new Error("guard source path is required");
  const guardPath = join(input.homeDir, ".agents/hooks/guard_shell.py");
  const filesChanged: GuardAppliedFile[] = [];
  const guardChange = await copyOwnedFile(source, guardPath);
  if (guardChange) filesChanged.push(guardChange);

  const libSource = join(dirname(source), "lib_payload.py");
  const libDest = join(dirname(guardPath), "lib_payload.py");
  try {
    const payloadChange = await copyOwnedFile(libSource, libDest);
    if (payloadChange) filesChanged.push(payloadChange);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }

  let settingsPath: string | null = null;
  if (input.pmWorkspacePath) {
    settingsPath = join(input.pmWorkspacePath, ".claude/settings.json");
    const previousHash = await hashOrNull(settingsPath);
    const settingsChange = await replaceSettingCas(
      settingsPath,
      /\/[^\s"]+\/lane-stack\/hooks\/guard_shell\.py/g,
      guardPath,
    );
    if (settingsChange) filesChanged.push({ ...settingsChange, sha256Before: previousHash });
  }
  return { guardPath, settingsPath, filesChanged };
}

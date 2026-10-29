import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { sha256Buffer } from "@lane-pilot/kit";

export type FileState = { text: string | null; sha256: string | null; mode: number | null };
export type FileCasResult = {
  status: "ok" | "conflict" | "failed";
  beforeSha256: string | null;
  afterSha256: string | null;
  changed: boolean;
  reason: string | null;
};

const LOCK_STALE_MS = 15_000;
const LOCK_WAIT_MS = 10_000;
const tails = new Map<string, Promise<void>>();

export async function readTextState(path: string): Promise<FileState> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) return { text: null, sha256: null, mode: null };
    const text = await readFile(path, "utf8");
    return { text, sha256: sha256Buffer(text), mode: info.mode & 0o777 };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { text: null, sha256: null, mode: null };
    throw error;
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM"); }
}

async function lockIsStale(lockPath: string): Promise<boolean> {
  try {
    const info = await lstat(lockPath);
    if (info.isSymbolicLink() || !info.isFile()) return true;
    const pid = Number((await readFile(lockPath, "utf8").catch(() => "")).split(" ")[0]);
    if (!pidAlive(pid)) return true;
    return Date.now() - info.mtimeMs > LOCK_STALE_MS;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
  }
}

async function acquireLock(lockPath: string): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await writeFile(lockPath, `${process.pid} ${Date.now()}\n`, { flag: "wx" });
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      if (code !== "EEXIST") throw error;
      if (await lockIsStale(lockPath)) { await rm(lockPath, { force: true }).catch(() => undefined); continue; }
      if (Date.now() > deadline) throw new Error("timed out waiting for the CAS lock");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

/** In-process queue plus an exclusive lock file, so two host workers cannot both pass the hash check. (2026-10-29 audit A-026) */
export function withCasLock<T>(path: string, body: () => Promise<T>): Promise<T> {
  return withTargetLock(path, body);
}

function withTargetLock<T>(path: string, body: () => Promise<T>): Promise<T> {
  const key = resolve(path);
  const previous = tails.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(async () => {
    const lockPath = join(dirname(key), `.${basename(key)}.lane-pilot-cas.lock`);
    await mkdir(dirname(key), { recursive: true });
    await acquireLock(lockPath);
    try { return await body(); }
    finally { await rm(lockPath, { force: true }).catch(() => undefined); }
  });
  const settled = run.then(() => undefined, () => undefined);
  tails.set(key, settled);
  void settled.finally(() => { if (tails.get(key) === settled) tails.delete(key); });
  return run;
}

export async function compareAndSwapText(
  path: string,
  expectedSha256: string | null | undefined,
  nextText: string,
): Promise<FileCasResult> {
  if (expectedSha256 === undefined) {
    return { status: "conflict", beforeSha256: null, afterSha256: null, changed: false, reason: "expectedSha256 is required for a file mutation." };
  }
  try { return await withCasLock(path, () => swapText(path, expectedSha256, nextText)); }
  catch (error) {
    return { status: "failed", beforeSha256: null, afterSha256: null, changed: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

async function swapText(path: string, expectedSha256: string | null, nextText: string): Promise<FileCasResult> {
  let before: FileState;
  try { before = await readTextState(path); }
  catch (error) {
    return { status: "failed", beforeSha256: null, afterSha256: null, changed: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (before.sha256 !== expectedSha256) {
    return { status: "conflict", beforeSha256: before.sha256, afterSha256: before.sha256, changed: false, reason: "CAS hash mismatch; file was not written." };
  }
  if (before.text === nextText) {
    return { status: "ok", beforeSha256: before.sha256, afterSha256: before.sha256, changed: false, reason: null };
  }

  const parent = dirname(path);
  const temporary = join(parent, `.lane-pilot-cas-${randomUUID()}.tmp`);
  await mkdir(parent, { recursive: true });
  try {
    await writeFile(temporary, nextText, { flag: "wx", mode: before.mode ?? 0o600 });
    const immediatelyBefore = await readTextState(path);
    if (immediatelyBefore.sha256 !== expectedSha256) {
      await rm(temporary, { force: true });
      return {
        status: "conflict",
        beforeSha256: immediatelyBefore.sha256,
        afterSha256: immediatelyBefore.sha256,
        changed: false,
        reason: "CAS hash changed during write preparation; concurrent file content was preserved.",
      };
    }
    if (expectedSha256 === null) {
      try { await link(temporary, path); }
      catch (error) {
        await rm(temporary, { force: true });
        const current = await readTextState(path);
        const code = error && typeof error === "object" && "code" in error ? error.code : null;
        if (code !== "EEXIST") {
          return {
            status: "failed",
            beforeSha256: current.sha256,
            afterSha256: current.sha256,
            changed: false,
            reason: error instanceof Error ? error.message : String(error),
          };
        }
        return {
          status: "conflict",
          beforeSha256: current.sha256,
          afterSha256: current.sha256,
          changed: false,
          reason: "CAS create conflict; a file appeared during write preparation and was preserved.",
        };
      }
      await rm(temporary, { force: true });
    } else {
      await rename(temporary, path);
    }
    const after = await readTextState(path);
    return { status: "ok", beforeSha256: before.sha256, afterSha256: after.sha256, changed: true, reason: null };
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    return { status: "failed", beforeSha256: before.sha256, afterSha256: before.sha256, changed: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

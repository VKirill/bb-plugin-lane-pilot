import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hashPath, sha256Buffer } from "../hash";
import type { CoexistenceManager, CoexistenceOwner } from "./contracts";
import { compareAndSwapText, readTextState } from "./cas";

export type OwnershipEntry = {
  manager: CoexistenceManager;
  path: string;
  ownedValue: string | null;
  owner: "lane-pilot";
  afterSha256: string;
  snapshotId: string;
  sourceSha: string | null;
};

export type CoexistenceSnapshot = {
  schemaVersion: 1;
  snapshotId: string;
  createdAt: string;
  manager: CoexistenceManager;
  path: string;
  operation: "install" | "connect" | "disconnect";
  owner: "lane-pilot";
  beforeSha256: string | null;
  afterSha256: string;
  ownedValue: string | null;
  sourceSha: string | null;
};

export type OwnershipLedger = { schemaVersion: 1; entries: OwnershipEntry[] };
export type OwnershipLedgerWrite = { beforeText: string | null; afterSha256: string };

export function coexistenceRoot(home: string): string {
  return join(home, ".agents/lane-pilot/coexistence");
}

export function snapshotPath(home: string, id: string): string {
  return join(coexistenceRoot(home), "snapshots", `${id}.json`);
}

export function ownershipLedgerPath(home: string): string {
  return join(coexistenceRoot(home), "ownership.json");
}

export async function readOwnershipLedger(home: string): Promise<OwnershipLedger> {
  try {
    const parsed = JSON.parse(await readFile(ownershipLedgerPath(home), "utf8")) as OwnershipLedger;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries)) return { schemaVersion: 1, entries: [] };
    return parsed;
  } catch { return { schemaVersion: 1, entries: [] }; }
}

export async function readOwnershipLedgerStrict(home: string): Promise<OwnershipLedger> {
  for (const directory of [
    join(home, ".agents"),
    join(home, ".agents/lane-pilot"),
    coexistenceRoot(home),
    join(coexistenceRoot(home), "snapshots"),
  ]) {
    try {
      const info = await lstat(directory);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`ownership metadata directory is not a real directory; preserving it: ${directory}`);
      }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
  }
  const ledgerPath = ownershipLedgerPath(home);
  let text: string;
  try {
    const info = await lstat(ledgerPath);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`ownership ledger is not a regular file; preserving it: ${ledgerPath}`);
    text = await readFile(ledgerPath, "utf8");
  }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { schemaVersion: 1, entries: [] };
    }
    throw error;
  }
  let parsed: OwnershipLedger;
  try { parsed = JSON.parse(text) as OwnershipLedger; }
  catch { throw new Error("ownership ledger is invalid JSON; preserving it without overwrite"); }
  if (!parsed || typeof parsed !== "object" || parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error("ownership ledger schema is unsupported; preserving it without overwrite");
  }
  for (const entry of parsed.entries) {
    if (!entry || !["agents-marker", "managed-checkout", "claude-cache", "claude-settings", "opencode-config", "opencode-plugin"].includes(entry.manager)
      || typeof entry.path !== "string"
      || entry.owner !== "lane-pilot" || typeof entry.afterSha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(entry.afterSha256) || typeof entry.snapshotId !== "string"
      || !(entry.ownedValue === null || typeof entry.ownedValue === "string")
      || !(entry.sourceSha === null || typeof entry.sourceSha === "string")) {
      throw new Error("ownership ledger contains an invalid entry; preserving it without overwrite");
    }
  }
  return parsed;
}

export async function addOwnershipEntry(home: string, entry: OwnershipEntry): Promise<OwnershipLedgerWrite> {
  const path = ownershipLedgerPath(home);
  await mkdir(coexistenceRoot(home), { recursive: true });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await readTextState(path);
    let ledger: OwnershipLedger = { schemaVersion: 1, entries: [] };
    if (current.text) {
      try { ledger = JSON.parse(current.text) as OwnershipLedger; } catch { throw new Error("ownership ledger is invalid JSON; preserving it without overwrite"); }
      if (ledger.schemaVersion !== 1 || !Array.isArray(ledger.entries)) throw new Error("ownership ledger schema is unsupported; preserving it without overwrite");
    }
    const entries = ledger.entries.filter((item) => !(item.manager === entry.manager && item.path === entry.path));
    entries.push(entry);
    const result = await compareAndSwapText(path, current.sha256, `${JSON.stringify({ schemaVersion: 1, entries }, null, 2)}\n`);
    if (result.status === "ok" && result.afterSha256) return { beforeText: current.text, afterSha256: result.afterSha256 };
    if (result.status === "failed") throw new Error(result.reason ?? "ownership ledger write failed");
  }
  throw new Error("ownership ledger changed repeatedly; no ownership entry was recorded");
}

export async function restoreOwnershipLedgerWrite(
  home: string,
  write: OwnershipLedgerWrite,
): Promise<{ status: "restored" | "conflict"; residualPaths: string[]; reason: string }> {
  const file = ownershipLedgerPath(home);
  const current = await readTextState(file);
  if (current.sha256 !== write.afterSha256) {
    return {
      status: "conflict",
      residualPaths: current.sha256 ? [file] : [],
      reason: "Rollback conflict: ownership ledger changed after this install committed; the newer ledger was preserved.",
    };
  }
  if (write.beforeText !== null) {
    const restored = await compareAndSwapText(file, write.afterSha256, write.beforeText);
    if (restored.status === "ok") {
      return { status: "restored", residualPaths: [], reason: "Previous ownership ledger bytes were restored by compare-and-swap." };
    }
    const latest = await readTextState(file);
    return {
      status: "conflict",
      residualPaths: latest.sha256 ? [file] : [],
      reason: "Rollback conflict: ownership ledger changed before its previous bytes could be restored; the newer ledger was preserved.",
    };
  }
  const quarantine = join(dirname(file), `.lane-pilot-ledger-rollback-${randomUUID()}.tmp`);
  try { await rename(file, quarantine); }
  catch (error) {
    return {
      status: "conflict",
      residualPaths: await readTextState(file).then((state) => state.sha256 ? [file] : []),
      reason: `Rollback conflict: ownership ledger could not be moved safely (${error instanceof Error ? error.message : String(error)}).`,
    };
  }
  const moved = await readTextState(quarantine);
  if (moved.sha256 !== write.afterSha256) {
    return {
      status: "conflict",
      residualPaths: moved.sha256 ? [quarantine] : [],
      reason: "Rollback conflict: ownership ledger changed during compensation; the moved content was preserved.",
    };
  }
  try { await unlink(quarantine); }
  catch (error) {
    return {
      status: "conflict",
      residualPaths: [quarantine],
      reason: `Rollback conflict: transaction ledger copy could not be removed (${error instanceof Error ? error.message : String(error)}).`,
    };
  }
  const final = await readTextState(file);
  if (write.beforeText === null && final.sha256 !== null) {
    return {
      status: "conflict",
      residualPaths: [file],
      reason: "Rollback conflict: a concurrent ownership ledger appeared after the install ledger was removed; it was preserved.",
    };
  }
  return { status: "restored", residualPaths: [], reason: "Previous ownership ledger bytes were restored." };
}

export async function removeOwnershipEntry(home: string, manager: CoexistenceManager, path: string): Promise<void> {
  const file = ownershipLedgerPath(home);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await readTextState(file);
    if (!current.text) return;
    let ledger: OwnershipLedger;
    try { ledger = JSON.parse(current.text) as OwnershipLedger; } catch { throw new Error("ownership ledger is invalid JSON; preserving it without overwrite"); }
    const entries = ledger.entries.filter((item) => !(item.manager === manager && item.path === path));
    if (entries.length === ledger.entries.length) return;
    const result = await compareAndSwapText(file, current.sha256, `${JSON.stringify({ schemaVersion: 1, entries }, null, 2)}\n`);
    if (result.status === "ok") return;
    if (result.status === "failed") throw new Error(result.reason ?? "ownership ledger update failed");
  }
  throw new Error("ownership ledger changed repeatedly; no ownership entry was removed");
}

export async function removeOwnershipEntryIfMatches(
  home: string,
  expected: Pick<OwnershipEntry, "manager" | "path" | "snapshotId" | "afterSha256">,
): Promise<"removed" | "absent" | "conflict"> {
  const file = ownershipLedgerPath(home);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const info = await lstat(file);
      if (info.isSymbolicLink() || !info.isFile()) return "conflict";
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "absent";
      throw error;
    }
    const current = await readTextState(file);
    if (!current.text) return "absent";
    let ledger: OwnershipLedger;
    try { ledger = JSON.parse(current.text) as OwnershipLedger; }
    catch { throw new Error("ownership ledger is invalid JSON; preserving it without overwrite"); }
    if (ledger.schemaVersion !== 1 || !Array.isArray(ledger.entries)) {
      throw new Error("ownership ledger schema is unsupported; preserving it without overwrite");
    }
    const index = ledger.entries.findIndex((entry) => entry.manager === expected.manager
      && entry.path === expected.path && entry.snapshotId === expected.snapshotId
      && entry.afterSha256 === expected.afterSha256);
    if (index < 0) {
      return ledger.entries.some((entry) => entry.manager === expected.manager && entry.path === expected.path)
        ? "conflict"
        : "absent";
    }
    const entries = ledger.entries.filter((_, row) => row !== index);
    const result = await compareAndSwapText(file, current.sha256, `${JSON.stringify({ schemaVersion: 1, entries }, null, 2)}\n`);
    if (result.status === "ok") return "removed";
    if (result.status === "failed") throw new Error(result.reason ?? "ownership ledger update failed");
  }
  return "conflict";
}

export type SnapshotFingerprint = {
  snapshotId: string;
  bytes: Buffer;
  sha256: string;
};

export type SnapshotResidual = {
  path: string;
  sha256: string | null;
  detail: string;
};

export type SnapshotRemovalResult = {
  status: "removed" | "absent" | "conflict";
  residuals: SnapshotResidual[];
};

export async function saveSnapshot(home: string, snapshot: Omit<CoexistenceSnapshot, "schemaVersion" | "createdAt">): Promise<SnapshotFingerprint> {
  const path = snapshotPath(home, snapshot.snapshotId);
  await mkdir(join(coexistenceRoot(home), "snapshots"), { recursive: true });
  const bytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, createdAt: new Date().toISOString(), ...snapshot }, null, 2)}\n`, "utf8");
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  return { snapshotId: snapshot.snapshotId, bytes, sha256: sha256Buffer(bytes) };
}

async function residualFor(path: string, detail: string): Promise<SnapshotResidual | null> {
  try { return { path, sha256: (await hashPath(path)).sha256, detail }; }
  catch { return null; }
}

async function removeEmptyClaimDirectory(path: string): Promise<SnapshotResidual[]> {
  try {
    await rmdir(path);
    return [];
  } catch {
    const residual = await residualFor(path, "Snapshot compensation left its private claim directory in place.");
    return residual ? [residual] : [];
  }
}

async function preserveClaimedSnapshot(
  originalPath: string,
  claimedPath: string,
  claimDirectory: string,
  claimedBytes: Buffer,
  detail: string,
): Promise<SnapshotRemovalResult> {
  let restoredAtOriginal = false;
  try {
    await writeFile(originalPath, claimedBytes, { flag: "wx", mode: 0o600 });
    const restored = await readFile(originalPath);
    restoredAtOriginal = restored.equals(claimedBytes);
  } catch {
    // An existing path belongs to a concurrent writer; keep the captured file below.
  }

  if (restoredAtOriginal) {
    try { await unlink(claimedPath); }
    catch { /* Keep and report the claimed copy if cleanup cannot complete. */ }
  }

  const residuals: SnapshotResidual[] = [];
  const originalResidual = await residualFor(originalPath, detail);
  if (originalResidual) residuals.push(originalResidual);
  const claimedResidual = await residualFor(claimedPath, "Captured concurrent snapshot bytes are preserved in the private claim path.");
  if (claimedResidual) residuals.push(claimedResidual);
  residuals.push(...await removeEmptyClaimDirectory(claimDirectory));
  return { status: "conflict", residuals };
}

export async function removeSnapshotIfMatches(
  home: string,
  expected: SnapshotFingerprint,
  options: { beforeClaim?: (path: string) => Promise<void> } = {},
): Promise<SnapshotRemovalResult> {
  const path = snapshotPath(home, expected.snapshotId);
  let info;
  try { info = await lstat(path); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { status: "absent", residuals: [] };
    throw error;
  }
  const expectedHash = sha256Buffer(expected.bytes);
  if (info.isSymbolicLink() || !info.isFile() || expectedHash !== expected.sha256) {
    const residual = await residualFor(path, "Snapshot was not removed because it is not the exact file written by this transaction.");
    return { status: "conflict", residuals: residual ? [residual] : [] };
  }

  const currentBytes = await readFile(path);
  if (!currentBytes.equals(expected.bytes) || sha256Buffer(currentBytes) !== expected.sha256) {
    const residual = await residualFor(path, "Snapshot bytes changed after this transaction wrote them; the changed file was preserved.");
    return { status: "conflict", residuals: residual ? [residual] : [] };
  }

  await options.beforeClaim?.(path);
  const claimDirectory = join(dirname(path), `.${expected.snapshotId}.claim-${randomUUID()}`);
  await mkdir(claimDirectory, { mode: 0o700 });
  const claimedPath = join(claimDirectory, "snapshot.json");
  try {
    await rename(path, claimedPath);
  } catch (error) {
    const directoryResiduals = await removeEmptyClaimDirectory(claimDirectory);
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return directoryResiduals.length
        ? { status: "conflict", residuals: directoryResiduals }
        : { status: "absent", residuals: [] };
    }
    throw error;
  }

  let claimedInfo;
  try { claimedInfo = await lstat(claimedPath); }
  catch {
    const residual = await residualFor(claimedPath, "Snapshot claim could not be inspected after atomic capture.");
    return { status: "conflict", residuals: residual ? [residual] : [] };
  }
  if (claimedInfo.isSymbolicLink() || !claimedInfo.isFile()) {
    const residuals: SnapshotResidual[] = [];
    const claimedResidual = await residualFor(claimedPath, "A concurrent non-file snapshot replacement was captured and preserved.");
    if (claimedResidual) residuals.push(claimedResidual);
    const originalResidual = await residualFor(path, "A replacement appeared at the snapshot path during compensation and was preserved.");
    if (originalResidual) residuals.push(originalResidual);
    return { status: "conflict", residuals };
  }

  const claimedBytes = await readFile(claimedPath);
  if (!claimedBytes.equals(expected.bytes) || sha256Buffer(claimedBytes) !== expected.sha256) {
    return preserveClaimedSnapshot(
      path,
      claimedPath,
      claimDirectory,
      claimedBytes,
      "Snapshot was replaced between the byte check and atomic claim; the replacement was preserved.",
    );
  }

  try { await unlink(claimedPath); }
  catch {
    const residual = await residualFor(claimedPath, "The exact transaction snapshot was captured but could not be removed.");
    return { status: "conflict", residuals: residual ? [residual] : [] };
  }
  const directoryResiduals = await removeEmptyClaimDirectory(claimDirectory);
  const replacementResidual = await residualFor(path, "A new snapshot file appeared after the transaction snapshot was removed and was preserved.");
  const residuals = [...directoryResiduals, ...(replacementResidual ? [replacementResidual] : [])];
  return residuals.length ? { status: "conflict", residuals } : { status: "removed", residuals: [] };
}

export async function readSnapshot(home: string, id: string): Promise<CoexistenceSnapshot | null> {
  if (!id || !/^[A-Za-z0-9_-]{8,80}$/.test(id)) return null;
  try {
    const parsed = JSON.parse(await readFile(snapshotPath(home, id), "utf8")) as CoexistenceSnapshot;
    return parsed.schemaVersion === 1 && parsed.snapshotId === id ? parsed : null;
  } catch { return null; }
}

export function newSnapshotId(): string {
  return randomUUID();
}

export function ownerForSnapshot(snapshot: CoexistenceSnapshot): CoexistenceOwner {
  return snapshot.owner;
}

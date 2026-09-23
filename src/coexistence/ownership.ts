import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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

export async function saveSnapshot(home: string, snapshot: Omit<CoexistenceSnapshot, "schemaVersion" | "createdAt">): Promise<void> {
  const path = snapshotPath(home, snapshot.snapshotId);
  await mkdir(join(coexistenceRoot(home), "snapshots"), { recursive: true });
  await writeFile(path, `${JSON.stringify({ schemaVersion: 1, createdAt: new Date().toISOString(), ...snapshot }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

export async function removeSnapshotIfMatches(
  home: string,
  expected: Pick<CoexistenceSnapshot, "snapshotId" | "manager" | "path" | "operation" | "afterSha256">,
): Promise<"removed" | "absent" | "conflict"> {
  const path = snapshotPath(home, expected.snapshotId);
  let info;
  try { info = await lstat(path); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "absent";
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) return "conflict";
  let parsed: CoexistenceSnapshot;
  try { parsed = JSON.parse(await readFile(path, "utf8")) as CoexistenceSnapshot; }
  catch { return "conflict"; }
  if (!parsed || typeof parsed !== "object" || parsed.schemaVersion !== 1 || parsed.owner !== "lane-pilot"
    || parsed.snapshotId !== expected.snapshotId || parsed.manager !== expected.manager
    || parsed.path !== expected.path || parsed.operation !== expected.operation
    || parsed.afterSha256 !== expected.afterSha256) return "conflict";
  await unlink(path);
  return "removed";
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

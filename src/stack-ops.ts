import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { EXTERNAL_OPS, EXTERNAL_OPS_WARNING, TARGET_SHA } from "./constants";
import { observeExternalOps } from "./external-ops";
import { applyInstalledGuard } from "./guard-apply";
import { readImportConfig } from "./import-config";
import { runInstallSh } from "./install-runner";
import { connectOpencode } from "./opencode-connect";
import { agentsDir, resolveHome } from "./paths";
import { skippedOpsReceipt, writeReceipt, type FileChange, type InstallReceipt } from "./receipt";
import { hideS8Files, restoreS8Files, s8Hashes } from "./s8";
import {
  finalizeSnapshotAfter,
  rollbackSnapshot,
  takeSnapshot,
  verifyRollback,
} from "./snapshot";
import { ensureUpstream } from "./upstream";

export type HostContext = {
  requestedHostId: string;
  homeDir?: string;
  workspacePath?: string;
  threadStoragePath?: string;
  receiptDir?: string;
  confirmExternalOps?: boolean;
  localFallbackPath?: string;
  guardSourcePath?: string;
  pmWorkspacePath?: string;
  projectId?: string;
  snapshotPath?: string;
  moduleUrl?: string;
};

function commandVersion(command: string): { present: boolean; version: string | null } {
  try {
    return { present: true, version: execFileSync(command, ["--version"], { encoding: "utf8", timeout: 5000 }).trim() };
  } catch {
    return { present: false, version: null };
  }
}

export async function readInstallJson(homeDir?: string): Promise<{
  sourceSha: string | null;
  version: string | null;
}> {
  try {
    const value = JSON.parse(await readFile(join(agentsDir(homeDir), "install.json"), "utf8")) as Record<string, unknown>;
    const sourceSha = typeof value.source_sha === "string" ? value.source_sha : null;
    const version = typeof value.version === "string" ? value.version : sourceSha;
    return { sourceSha, version };
  } catch {
    return { sourceSha: null, version: null };
  }
}

export function scenarioOf(sourceSha: string | null): "S1" | "S2" | "S3" {
  if (sourceSha === TARGET_SHA) return "S1";
  if (sourceSha) return "S2";
  return "S3";
}

export async function detectStack(ctx: HostContext) {
  const home = resolveHome(ctx.homeDir);
  const install = await readInstallJson(home);
  const workspacePath = ctx.workspacePath ?? home;
  return {
    hostId: process.env.BB_HOST_ID ?? ctx.requestedHostId,
    laneStack: {
      present: install.sourceSha !== null || install.version !== null,
      version: install.version,
      sourceSha: install.sourceSha,
    },
    openCode: commandVersion("opencode"),
    workspace: { path: workspacePath, present: await stat(workspacePath).then(() => true, () => false) },
    targetSha: TARGET_SHA,
    matchesTarget: install.sourceSha === TARGET_SHA,
    scenario: scenarioOf(install.sourceSha),
  };
}

async function receiptDirOf(ctx: HostContext): Promise<string | null> {
  if (ctx.receiptDir) return ctx.receiptDir;
  if (ctx.threadStoragePath) return join(ctx.threadStoragePath, "artifacts");
  return null;
}

export async function snapshotStack(ctx: HostContext): Promise<InstallReceipt> {
  const home = resolveHome(ctx.homeDir);
  const snap = await takeSnapshot({ homeDir: home, threadStoragePath: ctx.threadStoragePath });
  const external = await observeExternalOps(home);
  return writeReceipt({
    action: "snapshot",
    scenario: scenarioOf((await readInstallJson(home)).sourceSha),
    filesChanged: snap.entries
      .filter((entry) => entry.kind !== "external")
      .map((entry) => ({ path: entry.path, sha256Before: entry.sha256Before, sha256After: entry.sha256After })),
    externalOpsBefore: external,
    externalOpsAfter: external,
    ...skippedOpsReceipt([]),
    exitCode: 0,
    snapshotPath: snap.snapshotPath,
    sourceSha: (await readInstallJson(home)).sourceSha,
    notes: [`manifest ${snap.manifestPath}`],
  }, await receiptDirOf(ctx));
}

export async function installStack(ctx: HostContext): Promise<InstallReceipt> {
  const home = resolveHome(ctx.homeDir);
  const before = await detectStack(ctx);
  const confirm = ctx.confirmExternalOps === true;
  if (before.scenario === "S1") {
    const external = await observeExternalOps(home);
    return writeReceipt({
      action: "install",
      scenario: "S1",
      filesChanged: [],
      externalOpsBefore: external,
      externalOpsAfter: external,
      ...skippedOpsReceipt(confirm ? [] : [...EXTERNAL_OPS]),
      exitCode: 0,
      snapshotPath: null,
      sourceSha: TARGET_SHA,
      notes: ["S1: target SHA already installed; reuse without install.sh"],
    }, await receiptDirOf(ctx));
  }

  const upstream = await ensureUpstream({
    homeDir: home,
    localFallbackPath: ctx.localFallbackPath,
    moduleUrl: ctx.moduleUrl,
  });
  const snap = await takeSnapshot({ homeDir: home, threadStoragePath: ctx.threadStoragePath });
  const s8Before = await s8Hashes(home);
  const stash = await hideS8Files(home);

  let installResult;
  try {
    installResult = await runInstallSh({
      stackRoot: upstream.path,
      homeDir: home,
      confirmExternalOps: confirm,
    });
  } finally {
    await restoreS8Files(stash, home);
  }

  await applyInstalledGuard({
    homeDir: home,
    guardSourcePath: ctx.guardSourcePath,
    moduleUrl: ctx.moduleUrl,
    pmWorkspacePath: ctx.pmWorkspacePath,
  });
  const connected = await connectOpencode(home);
  await finalizeSnapshotAfter(snap, home);
  const s8After = await s8Hashes(home);
  const s8Notes = Object.keys(s8Before).map((path) => (
    s8Before[path] === s8After[path]
      ? `S8 unchanged ${path}`
      : `S8 MISMATCH ${path}`
  ));

  const filesChanged: FileChange[] = [];
  for (const entry of snap.entries) {
    if (entry.kind === "external") continue;
    filesChanged.push({
      path: entry.path,
      sha256Before: entry.sha256Before,
      sha256After: entry.sha256After,
    });
  }
  for (const file of connected.files) {
    filesChanged.push({
      path: file.path,
      sha256Before: file.sha256Before,
      sha256After: file.sha256After,
    });
  }

  const after = await readInstallJson(home);
  const notes = [
    `upstream ${upstream.source} ${upstream.path}`,
    `install.sh exit ${installResult.exitCode}`,
    connected.skipped ? `S5/S6 ${connected.reason}` : `S5 patched ${connected.files.map((file) => file.path).join(",")}`,
    connected.files[0]?.limitation ? `§12 ${connected.files[0].limitation}` : "",
    ...s8Notes,
    confirm ? "external ops confirmed" : "external ops skipped; LANE_INSTALL_CLAUDE_PLUGIN=0",
  ].filter(Boolean);

  return writeReceipt({
    action: "install",
    scenario: before.scenario,
    filesChanged,
    externalOpsBefore: Object.fromEntries(snap.entries
      .filter((entry) => entry.kind === "external")
      .map((entry) => [entry.path, entry.externalOpsBefore])),
    externalOpsAfter: Object.fromEntries(snap.entries
      .filter((entry) => entry.kind === "external")
      .map((entry) => [entry.path, entry.externalOpsAfter])),
    skippedExternalOps: installResult.skippedExternalOps,
    warning: installResult.skippedExternalOps.length > 0 ? EXTERNAL_OPS_WARNING : null,
    exitCode: installResult.exitCode,
    snapshotPath: snap.snapshotPath,
    sourceSha: after.sourceSha,
    notes: [...notes, installResult.stderr.slice(0, 2000)],
  }, await receiptDirOf(ctx));
}

export async function rollbackStack(ctx: HostContext): Promise<InstallReceipt> {
  if (!ctx.snapshotPath) throw new Error("snapshotPath is required for rollback");
  const home = resolveHome(ctx.homeDir);
  const before = await observeExternalOps(home);
  const result = await rollbackSnapshot(ctx.snapshotPath);
  const verified = await verifyRollback(ctx.snapshotPath);
  const after = await observeExternalOps(home);
  return writeReceipt({
    action: "rollback",
    scenario: scenarioOf((await readInstallJson(home)).sourceSha),
    filesChanged: [
      ...result.restored.map((path) => ({ path, sha256Before: null, sha256After: null })),
      ...result.removed.map((path) => ({ path, sha256Before: null, sha256After: null })),
    ],
    externalOpsBefore: before,
    externalOpsAfter: after,
    ...skippedOpsReceipt([]),
    exitCode: verified.ok ? 0 : 1,
    snapshotPath: ctx.snapshotPath,
    sourceSha: (await readInstallJson(home)).sourceSha,
    notes: [
      `restored ${result.restored.length}`,
      `removed ${result.removed.length}`,
      verified.ok ? "sha verify ok" : `sha mismatches ${JSON.stringify(verified.mismatches)}`,
    ],
  }, await receiptDirOf(ctx));
}

export async function importConfigStack(ctx: HostContext): Promise<InstallReceipt & {
  imported: ImportedPayload;
}> {
  const imported = await readImportConfig({
    homeDir: ctx.homeDir,
    workspacePath: ctx.workspacePath,
  });
  return {
    ...(await writeReceipt({
      action: "importConfig",
      scenario: "S7",
      filesChanged: [
        ...(imported.routingProfile ? [{
          path: imported.routingProfile.path,
          sha256Before: imported.routingProfile.sha256,
          sha256After: imported.routingProfile.sha256,
        }] : []),
        ...(imported.nightShift ? [{
          path: imported.nightShift.path,
          sha256Before: imported.nightShift.sha256,
          sha256After: imported.nightShift.sha256,
        }] : []),
      ],
      externalOpsBefore: {},
      externalOpsAfter: {},
      ...skippedOpsReceipt([]),
      exitCode: 0,
      snapshotPath: null,
      sourceSha: (await readInstallJson(ctx.homeDir)).sourceSha,
      notes: ["S7 read-only; persistence is a server one-shot insert"],
    }, await receiptDirOf(ctx))),
    imported,
  };
}

type ImportedPayload = Awaited<ReturnType<typeof readImportConfig>>;

export async function connectOpencodeStack(ctx: HostContext): Promise<InstallReceipt> {
  const home = resolveHome(ctx.homeDir);
  const first = await connectOpencode(home);
  const second = first.skipped ? first : await connectOpencode(home);
  const idempotent = !first.skipped && second.files.every((file, index) => (
    file.sha256After === first.files[index]?.sha256After && !file.changed
  ));
  return writeReceipt({
    action: "connectOpencode",
    scenario: first.skipped ? "S6" : "S5",
    filesChanged: first.files.map((file) => ({
      path: file.path,
      sha256Before: file.sha256Before,
      sha256After: file.sha256After,
    })),
    externalOpsBefore: {},
    externalOpsAfter: {},
    ...skippedOpsReceipt([]),
    exitCode: first.skipped && first.reason?.startsWith("opencode --version") ? 1 : 0,
    snapshotPath: null,
    sourceSha: (await readInstallJson(home)).sourceSha,
    notes: [
      first.reason ?? `opencode ${first.version}`,
      first.files[0]?.limitation ? `§12 ${first.files[0].limitation}` : "",
      idempotent ? "second pass no-op" : "second pass not identical",
    ].filter(Boolean),
  }, await receiptDirOf(ctx));
}

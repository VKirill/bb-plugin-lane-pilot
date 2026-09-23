import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { EXTERNAL_OPS, TARGET_SHA } from "./constants";
import { observeExternalOps, type ExternalOpsSnapshot } from "./external-ops";
import { applyInstalledGuard, isOwnedPmGuardApplied, ownedPmGuardPath } from "./guard-apply";
import { readImportConfig } from "./import-config";
import type { InstallPhase } from "./install-runner";
import { connectOpencode } from "./opencode-connect";
import { inventoryCoexistenceAtHome, runCoexistenceOperationAtHome } from "./coexistence";
import { agentsDir, defaultLocalFallback, resolveHome } from "./paths";
import { skippedOpsReceipt, writeReceipt, type FileChange, type InstallReceipt } from "./receipt";
import {
  finalizeSnapshotAfter,
  rollbackSnapshot,
  takeSnapshot,
  verifyRollback,
} from "./snapshot";
import { assessEngineCapabilities, inspectEngineCapabilities } from "./upstream-adapter/capabilities";

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
  stopAfterPhase?: InstallPhase;
  installSettings?: Record<string, unknown>;
};

function commandVersion(command: string): { present: boolean; version: string | null } {
  try {
    return { present: true, version: execFileSync(command, ["--version"], { encoding: "utf8", timeout: 5000 }).trim() };
  } catch {
    return { present: false, version: null };
  }
}

function gitHead(root: string): string | null {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
      timeout: 4000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch { return null; }
}

function unobservedExternalOps(): ExternalOpsSnapshot {
  return Object.fromEntries(EXTERNAL_OPS.map((operation) => [operation, null])) as ExternalOpsSnapshot;
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
  const inventory = await inventoryCoexistenceAtHome({
    projectId: ctx.projectId ?? "lane-pilot",
    hostId: ctx.requestedHostId,
    targetSha: TARGET_SHA,
  }, home);
  const engineRows = inventory.managers.filter((row) => ["agents-marker", "managed-checkout", "claude-cache"].includes(row.manager));
  const compatibleRows = engineRows.filter((row) => row.compatible === true);
  const fallbackRoot = ctx.localFallbackPath ?? (ctx.moduleUrl ? defaultLocalFallback(ctx.moduleUrl) : null);
  let fallbackAssessment: ReturnType<typeof assessEngineCapabilities> | null = null;
  if (fallbackRoot) {
    try {
      await stat(fallbackRoot);
      fallbackAssessment = assessEngineCapabilities(await inspectEngineCapabilities(fallbackRoot));
    } catch { /* an unavailable fallback is not an installed source */ }
  }
  const fallbackCompatible = fallbackAssessment?.compatible === true;
  const requiredCapabilities = [...new Set([
    ...engineRows.flatMap((row) => row.capabilities),
    ...(fallbackAssessment?.capabilities ?? []),
  ])].sort();
  const missingCapabilities = [...new Set([
    ...engineRows.flatMap((row) => row.missingCapabilities),
    ...(fallbackAssessment?.missingCapabilities ?? []),
  ])].sort();
  const compatible = compatibleRows.length > 0 || fallbackCompatible;
  const sources: Array<{ manager: string; path: string; version: string | null; sourceSha: string | null }> = compatibleRows.map((row) => ({
    manager: row.manager,
    path: row.path,
    version: row.version,
    sourceSha: row.sourceSha,
  }));
  if (fallbackCompatible && fallbackRoot && !sources.some((source) => source.path === fallbackRoot)) {
    sources.push({ manager: "local-fallback", path: fallbackRoot, version: null, sourceSha: gitHead(fallbackRoot) });
  }
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
    compatibility: {
      compatible,
      decision: compatible ? "reuse" as const : "install" as const,
      sources,
      capabilities: requiredCapabilities,
      missingCapabilities,
      diagnostics: [
        ...engineRows.flatMap((row) => row.evidence.filter((item) => item.kind === "capability").map((item) => item.detail)),
        ...(fallbackAssessment?.diagnostics.map((item) => item.message) ?? []),
      ],
    },
    scenario: compatible ? "S1" as const : scenarioOf(install.sourceSha),
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

async function configureOwnedPmGuard(ctx: HostContext, home: string): Promise<{
  snapshotPath: string | null;
  filesChanged: FileChange[];
  note: string | null;
}> {
  if (!ctx.pmWorkspacePath) return { snapshotPath: null, filesChanged: [], note: null };
  if (await isOwnedPmGuardApplied({
    homeDir: home,
    guardSourcePath: ctx.guardSourcePath,
    moduleUrl: ctx.moduleUrl,
    pmWorkspacePath: ctx.pmWorkspacePath,
  })) return { snapshotPath: null, filesChanged: [], note: "PM guard already active in the Lane Pilot-owned namespace" };

  const guardPath = ownedPmGuardPath(home);
  const payloadPath = join(home, ".agents/lane-pilot/pm/lib_payload.py");
  const settingsPath = join(ctx.pmWorkspacePath, ".claude/settings.json");
  const snapshot = await takeSnapshot({
    homeDir: home,
    threadStoragePath: ctx.threadStoragePath,
    additionalPaths: [guardPath, payloadPath, settingsPath],
    includeManifest: false,
  });
  try {
    const applied = await applyInstalledGuard({
      homeDir: home,
      guardSourcePath: ctx.guardSourcePath,
      moduleUrl: ctx.moduleUrl,
      pmWorkspacePath: ctx.pmWorkspacePath,
    });
    await finalizeSnapshotAfter(snapshot, home);
    return {
      snapshotPath: snapshot.snapshotPath,
      filesChanged: applied.filesChanged,
      note: `PM guard installed in its Lane Pilot-owned namespace and added to ${applied.settingsPath} with CAS`,
    };
  } catch (error) {
    await finalizeSnapshotAfter(snapshot, home).catch(() => undefined);
    await rollbackSnapshot(snapshot.snapshotPath).catch(() => undefined);
    throw error;
  }
}

export async function installStack(ctx: HostContext): Promise<InstallReceipt> {
  const home = resolveHome(ctx.homeDir);
  const before = await detectStack(ctx);
  const confirm = ctx.confirmExternalOps === true;
  const external = unobservedExternalOps();
  if (before.compatibility.compatible) {
    let pmGuard: Awaited<ReturnType<typeof configureOwnedPmGuard>>;
    try {
      pmGuard = await configureOwnedPmGuard(ctx, home);
    } catch (error) {
      return writeReceipt({
        action: "install",
        scenario: before.scenario,
        status: "failed",
        filesChanged: [],
        externalOpsBefore: external,
        externalOpsAfter: external,
        ...skippedOpsReceipt(confirm ? [] : [...EXTERNAL_OPS]),
        exitCode: 1,
        snapshotPath: null,
        sourceSha: before.laneStack.sourceSha,
        notes: [
          "Compatible engine was preserved",
          `PM guard operation failed: ${error instanceof Error ? error.message : "unknown guard error"}`,
          "PM workspace updates use an additive CAS patch; user settings are preserved on conflict",
        ],
      }, await receiptDirOf(ctx));
    }
    return writeReceipt({
      action: "install",
      scenario: before.scenario,
      filesChanged: pmGuard.filesChanged,
      externalOpsBefore: external,
      externalOpsAfter: external,
      ...skippedOpsReceipt(confirm ? [] : [...EXTERNAL_OPS]),
      exitCode: 0,
      snapshotPath: pmGuard.snapshotPath,
      sourceSha: before.compatibility.sources.find((source) => source.path === ctx.localFallbackPath)?.sourceSha
        ?? before.compatibility.sources.find((source) => source.sourceSha)?.sourceSha
        ?? before.laneStack.sourceSha,
      notes: [
        `Compatible engine reused from ${before.compatibility.sources.map((source) => `${source.manager}:${source.path}`).join(", ")}; version/SHA/dirty state did not trigger writes`,
        "No install.sh, engine, ordinary user config, or cache writes were made",
        ...(pmGuard.note ? [pmGuard.note] : []),
      ],
    }, await receiptDirOf(ctx));
  }

  // Marker contents do not grant permission to run an upstream installer against HOME.
  // Missing, malformed, and incompatible markers all use this same owned managed path.
  const inventory = await inventoryCoexistenceAtHome({
    projectId: ctx.projectId ?? "lane-pilot",
    hostId: ctx.requestedHostId,
    targetSha: TARGET_SHA,
  }, home);
  const managed = inventory.managers.find((row) => row.manager === "managed-checkout");
  if (!managed) {
    return writeReceipt({
      action: "install",
      scenario: before.scenario,
      status: "failed",
      filesChanged: [],
      externalOpsBefore: external,
      externalOpsAfter: external,
      ...skippedOpsReceipt(confirm ? [] : [...EXTERNAL_OPS]),
      exitCode: 1,
      snapshotPath: null,
      sourceSha: before.laneStack.sourceSha,
      notes: ["Managed-checkout inventory path is unavailable; no installer was run with the ordinary HOME."],
    }, await receiptDirOf(ctx));
  }

  let operation;
  try {
    operation = await runCoexistenceOperationAtHome({
      projectId: ctx.projectId ?? "lane-pilot",
      hostId: ctx.requestedHostId,
      operation: "install",
      manager: "managed-checkout",
      path: managed.path,
      expectedSha256: managed.sha256,
      targetSha: TARGET_SHA,
    }, home, { localFallbackPath: ctx.localFallbackPath, moduleUrl: ctx.moduleUrl });
  } catch (error) {
    return writeReceipt({
      action: "install",
      scenario: before.scenario,
      status: "failed",
      filesChanged: [],
      externalOpsBefore: external,
      externalOpsAfter: unobservedExternalOps(),
      ...skippedOpsReceipt(confirm ? [] : [...EXTERNAL_OPS]),
      exitCode: 1,
      snapshotPath: null,
      sourceSha: before.laneStack.sourceSha,
      notes: [
        "Legacy install.sh was not run with the ordinary HOME",
        `Managed engine operation failed before a write: ${error instanceof Error ? error.message : "unknown adapter error"}`,
      ],
    }, await receiptDirOf(ctx));
  }

  const ok = operation.status === "ok" || operation.status === "skipped";
  const changed = operation.beforeSha256 !== operation.afterSha256;
  let pmGuard: Awaited<ReturnType<typeof configureOwnedPmGuard>> = { snapshotPath: null, filesChanged: [], note: null };
  if (ok) {
    try {
      pmGuard = await configureOwnedPmGuard(ctx, home);
    } catch (error) {
      let engineRollback = "not needed";
      if (operation.status === "ok" && operation.snapshotId && operation.afterSha256) {
        const rolledBack = await runCoexistenceOperationAtHome({
          projectId: ctx.projectId ?? "lane-pilot",
          hostId: ctx.requestedHostId,
          operation: "rollback",
          manager: "managed-checkout",
          path: operation.path,
          expectedSha256: operation.afterSha256,
          snapshotId: operation.snapshotId,
          targetSha: TARGET_SHA,
        }, home).catch((rollbackError) => ({ status: "blocked" as const, reason: rollbackError instanceof Error ? rollbackError.message : "rollback failed" }));
        engineRollback = `${rolledBack.status}${rolledBack.reason ? `: ${rolledBack.reason}` : ""}`;
      }
      return writeReceipt({
        action: "install",
        scenario: before.scenario,
        status: "failed",
        filesChanged: [],
        externalOpsBefore: external,
        externalOpsAfter: unobservedExternalOps(),
        ...skippedOpsReceipt(confirm ? [] : [...EXTERNAL_OPS]),
        exitCode: 1,
        snapshotPath: operation.snapshotId,
        sourceSha: before.laneStack.sourceSha,
        notes: [
          "Managed engine install was kept separate from the ordinary HOME installer",
          `PM guard operation failed: ${error instanceof Error ? error.message : "unknown guard error"}`,
          `Guard config snapshot rollback attempted; engine rollback ${engineRollback}`,
        ],
      }, await receiptDirOf(ctx));
    }
  }

  return writeReceipt({
    action: "install",
    scenario: before.scenario,
    status: ok ? "ok" : "failed",
    filesChanged: [
      ...(changed && operation.afterSha256 ? [{ path: operation.path, sha256Before: operation.beforeSha256, sha256After: operation.afterSha256 }] : []),
      ...pmGuard.filesChanged,
    ],
    externalOpsBefore: external,
    externalOpsAfter: unobservedExternalOps(),
    ...skippedOpsReceipt(confirm ? [] : [...EXTERNAL_OPS]),
    exitCode: ok ? 0 : 1,
    snapshotPath: pmGuard.snapshotPath ?? operation.snapshotId,
    sourceSha: operation.status === "ok" ? TARGET_SHA : before.laneStack.sourceSha,
    notes: [
      "Legacy install.sh was not run with the ordinary HOME",
      `Ownership operation ${operation.status} for ${operation.manager}:${operation.path}; owner ${operation.owner}`,
      ...operation.evidence.map((item) => item.detail),
      ...(pmGuard.note ? [pmGuard.note] : []),
      ...(pmGuard.snapshotPath && operation.snapshotId ? [`Managed engine ownership snapshot ${operation.snapshotId}`] : []),
      ...(operation.reason ? [operation.reason] : []),
      "Ordinary Claude settings, OpenCode config, install marker, and cache were outside this operation's write set; only the explicitly supplied PM workspace receives an additive hook entry",
    ],
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
      `CAS conflicts ${result.conflicts.length}${result.conflicts.length ? ` ${JSON.stringify(result.conflicts)}` : ""}`,
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
    exitCode: first.conflict || (first.skipped && first.reason?.startsWith("opencode --version")) ? 1 : 0,
    snapshotPath: null,
    sourceSha: (await readInstallJson(home)).sourceSha,
    notes: [
      first.reason ?? `opencode ${first.version}`,
      first.files[0]?.limitation ? `§12 ${first.files[0].limitation}` : "",
      idempotent ? "second pass no-op" : "second pass not identical",
    ].filter(Boolean),
  }, await receiptDirOf(ctx));
}

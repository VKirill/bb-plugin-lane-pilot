import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, lstat, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse, type ParseError } from "jsonc-parser/lib/esm/main.js";
import { TARGET_SHA } from "../constants";
import { hashPath } from "../hash";
import { agentsDir, resolveHome } from "../paths";
import { assessEngineCapabilities, IMPACTED_FUNCTIONS, inspectEngineCapabilities } from "../upstream-adapter/capabilities";
import { createOpenCodePluginShim, isManagedOpenCodePlugin } from "../upstream-adapter/opencode-plugin";
import { ensureUpstream } from "../upstream";
import { ensureOpenCodePluginEntry, removeOpenCodePluginEntry } from "../jsonc";
import { compareAndSwapText, readTextState } from "./cas";
import { addOwnershipEntry, newSnapshotId, readOwnershipLedger, readSnapshot, removeOwnershipEntry, saveSnapshot } from "./ownership";
import type {
  CoexistenceEvidence,
  CoexistenceInventory,
  CoexistenceInventoryInput,
  CoexistenceManagerState,
  CoexistenceOperationInput,
  CoexistenceOperationResult,
  CoexistenceOwner,
} from "./contracts";

export * from "./contracts";

type InstallMarker = { source_sha?: string; source_repo?: string; version?: string };

function assertInput(projectId: string, hostId: string): void {
  if (!projectId.trim()) throw new Error("projectId is required");
  if (!hostId.trim()) throw new Error("hostId is required");
  const currentHost = process.env.BB_HOST_ID;
  if (currentHost && currentHost !== hostId) throw new Error(`requested host ${hostId} does not match local host ${currentHost}`);
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function readMarker(home: string): Promise<InstallMarker> {
  try { return JSON.parse(await readFile(join(agentsDir(home), "install.json"), "utf8")) as InstallMarker; }
  catch { return {}; }
}

function gitValue(root: string, args: string[]): string | null {
  try { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 4000 }).trim(); }
  catch { return null; }
}

async function pathHash(path: string): Promise<string | null> {
  try { return (await hashPath(path)).sha256; } catch { return null; }
}

async function parseJsonc(path: string): Promise<Record<string, unknown> | null> {
  try {
    const errors: ParseError[] = [];
    const parsed = parse(await readFile(path, "utf8"), errors, { allowTrailingComma: true, disallowComments: false });
    return errors.length === 0 && parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch { return null; }
}

async function addEngineEvidence(
  state: CoexistenceManagerState,
  root: string | null,
): Promise<void> {
  if (!root) return;
  const rootSha256 = await pathHash(root);
  state.evidence.push({ kind: "engine-root", path: root, sha256: rootSha256, detail: "Read-only source root used for capability inspection." });
  const capabilities = await inspectEngineCapabilities(root);
  const assessment = assessEngineCapabilities(capabilities);
  state.capabilities = [...new Set([...assessment.capabilities, ...assessment.adaptedCapabilities])].sort();
  state.missingCapabilities = assessment.missingCapabilities;
  state.compatible = assessment.compatible;
  for (const capability of assessment.adaptedCapabilities) {
    state.evidence.push({
      kind: "capability",
      path: root,
      sha256: rootSha256,
      detail: `Required interface ${capability} is supplied by the local adapter; impacted function: ${IMPACTED_FUNCTIONS[capability]}.`,
    });
  }
  for (const diagnostic of assessment.diagnostics) {
    state.evidence.push({ kind: "capability", path: root, sha256: rootSha256, detail: diagnostic.message });
  }
}

function emptyState(
  manager: CoexistenceManagerState["manager"],
  path: string,
  owner: CoexistenceOwner = "unknown",
): CoexistenceManagerState {
  return {
    manager,
    path,
    installed: false,
    configured: false,
    loaded: null,
    compatible: null,
    modified: null,
    version: null,
    sourceSha: null,
    sha256: null,
    owner,
    decision: "skip",
    capabilities: [],
    missingCapabilities: [],
    evidence: [],
  };
}

function cacheCandidates(home: string): Promise<string[]> {
  const parent = join(home, ".claude/plugins/cache/claude-lane-stack/lane-stack");
  return readdir(parent, { withFileTypes: true })
    .then((entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => join(parent, entry.name)).sort())
    .catch(() => []);
}

async function managedEngineCandidates(home: string, targetSha: string): Promise<string[]> {
  const parent = join(home, ".agents/lane-pilot/engines");
  const canonical = join(parent, targetSha);
  const variants = await readdir(parent, { withFileTypes: true })
    .then((entries) => entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${targetSha}-managed-`))
      .map((entry) => join(parent, entry.name))
      .sort())
    .catch(() => []);
  return [canonical, ...variants];
}

async function findEngineRoot(home: string, marker: InstallMarker, targetSha: string): Promise<string | null> {
  const candidates = [
    marker.source_repo,
    ...(await managedEngineCandidates(home, targetSha)),
    join(home, ".agents/lane-pilot/upstream", targetSha),
    ...(await cacheCandidates(home)),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  for (const root of candidates) {
    if (!await exists(join(root, "profiles/opencode/opencode-lane/index.ts"))) continue;
    const assessment = assessEngineCapabilities(await inspectEngineCapabilities(root));
    if (assessment.compatible) return root;
  }
  for (const root of candidates) if (await exists(root)) return root;
  return null;
}

function pluginEntries(parsed: Record<string, unknown> | null): string[] {
  return Array.isArray(parsed?.plugin) ? parsed.plugin.filter((item): item is string => typeof item === "string") : [];
}

async function inventoryForHome(input: CoexistenceInventoryInput, home: string): Promise<CoexistenceInventory> {
  const targetSha = input.targetSha ?? TARGET_SHA;
  const markerPath = join(agentsDir(home), "install.json");
  const marker = await readMarker(home);
  const engineRoot = await findEngineRoot(home, marker, targetSha);
  const markerState = emptyState("agents-marker", markerPath, marker.source_repo ? "user" : "upstream");
  markerState.installed = await exists(markerPath);
  markerState.configured = Boolean(marker.source_sha || marker.source_repo);
  markerState.version = marker.version ?? null;
  markerState.sourceSha = marker.source_sha ?? null;
  markerState.sha256 = await pathHash(markerPath);
  markerState.path = markerPath;
  markerState.decision = marker.source_repo && await exists(marker.source_repo)
    ? "reuse"
    : markerState.installed ? "skip" : "skip";
  if (marker.source_repo && await exists(marker.source_repo)) {
    await addEngineEvidence(markerState, marker.source_repo);
    markerState.decision = markerState.compatible ? "reuse" : "conflict";
  }
  else if (marker.source_sha) markerState.evidence.push({ kind: "provenance", path: markerPath, sha256: markerState.sha256, detail: `Recorded source SHA ${marker.source_sha}; compatibility could not be proven because no engine interface root was found.` });

  const managedPaths = await managedEngineCandidates(home, targetSha);
  const managedStates: CoexistenceManagerState[] = [];
  for (const managedPath of managedPaths) {
    const managed = emptyState("managed-checkout", managedPath, "lane-pilot");
    managed.installed = await exists(managedPath);
    managed.sha256 = await pathHash(managedPath);
    managed.sourceSha = gitValue(managedPath, ["rev-parse", "HEAD"]);
    managed.version = (await readPackageVersion(managedPath)) ?? (managed.sourceSha ? managed.sourceSha.slice(0, 12) : null);
    managed.modified = gitValue(managedPath, ["status", "--porcelain"])?.length ? true : managed.sourceSha ? false : null;
    if (managed.installed) await addEngineEvidence(managed, managedPath);
    managed.decision = managed.compatible ? "reuse" : managed.installed ? "conflict" : "install";
    if (managed.installed && !managed.compatible && managed.missingCapabilities.length === 0) {
      managed.evidence.push({ kind: "capability", path: managedPath, sha256: managed.sha256, detail: "Engine source does not expose the required OpenCode module interface." });
    }
    managedStates.push(managed);
  }

  const cacheStates: CoexistenceManagerState[] = [];
  for (const cachePath of await cacheCandidates(home)) {
    const cache = emptyState("claude-cache", cachePath, "upstream");
    cache.installed = true;
    cache.sha256 = await pathHash(cachePath);
    cache.sourceSha = gitValue(cachePath, ["rev-parse", "HEAD"]);
    cache.version = (await readPackageVersion(cachePath)) ?? cachePath.split(/[\\/]/).at(-1) ?? null;
    cache.modified = gitValue(cachePath, ["status", "--porcelain"])?.length ? true : cache.sourceSha ? false : null;
    await addEngineEvidence(cache, cachePath);
    cache.decision = cache.compatible ? "reuse" : "conflict";
    cacheStates.push(cache);
  }

  const claudeSettingsPath = join(home, ".claude/settings.json");
  const claudeSettings = emptyState("claude-settings", claudeSettingsPath, "user");
  claudeSettings.installed = await exists(claudeSettingsPath);
  claudeSettings.sha256 = await pathHash(claudeSettingsPath);
  const claudeConfig = await readJsonFile(claudeSettingsPath);
  claudeSettings.configured = Boolean(claudeConfig && JSON.stringify(claudeConfig).includes("claude-lane-stack"));
  claudeSettings.decision = "skip";
  claudeSettings.evidence.push({ kind: "preservation", path: claudeSettingsPath, sha256: claudeSettings.sha256, detail: "User-owned Claude settings are read-only for this adapter." });

  const opencodeConfigPath = await preferredOpenCodeConfig(home);
  const opencodeConfig = emptyState("opencode-config", opencodeConfigPath, "user");
  opencodeConfig.installed = await exists(opencodeConfigPath);
  opencodeConfig.sha256 = await pathHash(opencodeConfigPath);
  const parsedConfig = await parseJsonc(opencodeConfigPath);
  const entries = pluginEntries(parsedConfig);
  const configuredRef = entries.find((entry) => entry.endsWith("opencode-lane.ts")) ?? null;
  const resolvedPluginPath = configuredRef
    ? configuredRef.startsWith("/") ? configuredRef : join(home, ".config/opencode", configuredRef.replace(/^\.\//, ""))
    : join(home, ".config/opencode/plugins/opencode-lane.ts");
  opencodeConfig.configured = Boolean(configuredRef);
  opencodeConfig.loaded = null;
  opencodeConfig.decision = configuredRef ? "reuse" : "install";
  opencodeConfig.evidence.push({ kind: "config", path: opencodeConfigPath, sha256: opencodeConfig.sha256, detail: configuredRef ? `Configured plugin entry ${configuredRef}; runtime load has not been proven by inventory.` : "No Lane Pilot OpenCode plugin entry is configured." });

  const opencodePlugin = emptyState("opencode-plugin", resolvedPluginPath, await exists(resolvedPluginPath) ? "lane-pilot" : "unknown");
  opencodePlugin.installed = await exists(resolvedPluginPath);
  opencodePlugin.configured = Boolean(configuredRef);
  opencodePlugin.sha256 = await pathHash(resolvedPluginPath);
  opencodePlugin.sourceSha = engineRoot ? gitValue(engineRoot, ["rev-parse", "HEAD"]) : null;
  opencodePlugin.version = engineRoot ? await readPackageVersion(engineRoot) : null;
  if (engineRoot) await addEngineEvidence(opencodePlugin, engineRoot);
  opencodePlugin.decision = opencodePlugin.installed && opencodePlugin.compatible ? "reuse" : opencodePlugin.installed ? "conflict" : engineRoot ? "install" : "conflict";
  opencodePlugin.evidence.push({ kind: "load", path: resolvedPluginPath, sha256: opencodePlugin.sha256, detail: opencodePlugin.installed ? "Plugin file exists; loaded remains unproven until OpenCode runtime receipt." : "Configured OpenCode plugin path does not exist; runtime load/action has not occurred." });

  return {
    schemaVersion: 1,
    hostId: process.env.BB_HOST_ID ?? input.hostId,
    targetSha,
    managers: [markerState, ...managedStates, ...cacheStates, claudeSettings, opencodeConfig, opencodePlugin],
  };
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

async function readPackageVersion(root: string): Promise<string | null> {
  const packageJson = await readJsonFile(join(root, "package.json"));
  return typeof packageJson?.version === "string" ? packageJson.version : null;
}

async function preferredOpenCodeConfig(home: string): Promise<string> {
  const jsonc = join(home, ".config/opencode/opencode.jsonc");
  if (await exists(jsonc)) return jsonc;
  return join(home, ".config/opencode/opencode.json");
}

export async function inventoryCoexistence(input: CoexistenceInventoryInput): Promise<CoexistenceInventory> {
  assertInput(input.projectId, input.hostId);
  return inventoryForHome(input, resolveHome());
}

export async function inventoryCoexistenceAtHome(
  input: CoexistenceInventoryInput,
  homeDir: string,
): Promise<CoexistenceInventory> {
  assertInput(input.projectId, input.hostId);
  return inventoryForHome(input, resolveHome(homeDir));
}

function resultOf(
  input: CoexistenceOperationInput,
  values: Partial<CoexistenceOperationResult> & Pick<CoexistenceOperationResult, "status" | "owner" | "reason">,
): CoexistenceOperationResult {
  return {
    schemaVersion: 1,
    hostId: process.env.BB_HOST_ID ?? input.hostId,
    operation: input.operation,
    manager: input.manager,
    path: values.path ?? input.path,
    status: values.status,
    beforeSha256: values.beforeSha256 ?? null,
    afterSha256: values.afterSha256 ?? null,
    snapshotId: values.snapshotId ?? input.snapshotId ?? null,
    owner: values.owner,
    evidence: values.evidence ?? [],
    reason: values.reason,
  };
}

async function anyPathHash(path: string): Promise<string | null> {
  try { return (await hashPath(path)).sha256; } catch { return null; }
}

function sourceShaOf(root: string): string | null {
  return gitValue(root, ["rev-parse", "HEAD"]);
}

async function removeOwnedPath(path: string, expectedSha256: string | null): Promise<{ status: "ok" | "conflict" | "failed"; before: string | null; after: string | null; reason: string | null }> {
  const before = await anyPathHash(path);
  if (before !== expectedSha256) return { status: "conflict", before, after: before, reason: "CAS hash mismatch; path was not removed." };
  if (before === null) return { status: "ok", before: null, after: null, reason: null };
  try {
    const quarantine = `${path}.lane-pilot-rollback-${randomUUID()}`;
    await rename(path, quarantine);
    const movedHash = await anyPathHash(quarantine);
    if (movedHash !== expectedSha256) {
      try { await rename(quarantine, path); } catch { /* keep the moved data in quarantine rather than overwrite a concurrent path */ }
      return { status: "conflict", before: movedHash, after: movedHash, reason: "CAS content changed during rollback; path was preserved." };
    }
    await rm(quarantine, { recursive: true, force: true });
    return { status: "ok", before, after: null, reason: null };
  } catch (error) {
    return { status: "failed", before, after: before, reason: error instanceof Error ? error.message : String(error) };
  }
}

async function managedEngineForOperation(home: string, targetSha: string): Promise<{ root: string | null; assessment: ReturnType<typeof assessEngineCapabilities> | null }> {
  const marker = await readMarker(home);
  const root = await findEngineRoot(home, marker, targetSha);
  if (!root) return { root: null, assessment: null };
  const assessment = assessEngineCapabilities(await inspectEngineCapabilities(root));
  return { root, assessment };
}

async function currentOperationRow(
  home: string,
  input: CoexistenceOperationInput,
): Promise<CoexistenceManagerState | null> {
  const inventory = await inventoryForHome({ projectId: input.projectId, hostId: input.hostId, targetSha: input.targetSha ?? undefined }, home);
  return inventory.managers.find((item) => item.manager === input.manager && item.path === input.path) ?? null;
}

async function snapshotOfWrite(input: {
  home: string;
  manager: CoexistenceOperationInput["manager"];
  path: string;
  operation: "install" | "connect" | "disconnect";
  beforeSha256: string | null;
  afterSha256: string;
  ownedValue: string | null;
  sourceSha: string | null;
}): Promise<string> {
  const snapshotId = newSnapshotId();
  await saveSnapshot(input.home, {
    snapshotId,
    manager: input.manager,
    path: input.path,
    operation: input.operation,
    owner: "lane-pilot",
    beforeSha256: input.beforeSha256,
    afterSha256: input.afterSha256,
    ownedValue: input.ownedValue,
    sourceSha: input.sourceSha,
  });
  await addOwnershipEntry(input.home, {
    manager: input.manager,
    path: input.path,
    ownedValue: input.ownedValue,
    owner: "lane-pilot",
    afterSha256: input.afterSha256,
    snapshotId,
    sourceSha: input.sourceSha,
  });
  return snapshotId;
}

const OPENCODE_PLUGIN_REF = "./plugins/opencode-lane.ts";

export async function runCoexistenceOperation(input: CoexistenceOperationInput): Promise<CoexistenceOperationResult> {
  assertInput(input.projectId, input.hostId);
  const home = resolveHome();
  const targetSha = input.targetSha ?? TARGET_SHA;
  const row = await currentOperationRow(home, input);
  if (!row) return resultOf(input, { status: "blocked", owner: "unknown", reason: "Manager/path pair is not present in the read-only inventory; arbitrary paths are rejected." });
  if (input.manager === "opencode-plugin" && input.path !== join(home, ".config/opencode/plugins/opencode-lane.ts")) {
    return resultOf(input, { status: "blocked", owner: row.owner, reason: "OpenCode plugin writes are limited to the Lane Pilot-owned path under ~/.config/opencode/plugins; configured custom paths are read-only." });
  }
  const currentHash = await anyPathHash(input.path);
  const mutation = ["install", "connect", "update", "disconnect", "rollback"].includes(input.operation);
  if (mutation && input.expectedSha256 === undefined) {
    return resultOf(input, { status: "conflict", owner: row.owner, beforeSha256: currentHash, afterSha256: currentHash, reason: "expectedSha256 is required for every path mutation." });
  }
  if (input.expectedSha256 !== undefined && currentHash !== input.expectedSha256) {
    return resultOf(input, { status: "conflict", owner: row.owner, beforeSha256: currentHash, afterSha256: currentHash, reason: "CAS hash mismatch; no path write was performed." });
  }

  if (input.operation === "update") {
    const selected = await managedEngineForOperation(home, targetSha);
    if (selected.assessment?.compatible) {
      return resultOf(input, { status: "skipped", owner: row.owner, beforeSha256: currentHash, afterSha256: currentHash, evidence: [{ kind: "reuse", path: selected.root, sha256: selected.assessment.capabilities.length ? await anyPathHash(selected.root!) : null, detail: "Required interfaces are present; version, source SHA, and modified state did not trigger an update." }], reason: "Compatible engine reused; update would create no writes." });
    }
    const diagnostic = selected.assessment?.diagnostics[0]?.message ?? "No inspectable engine root is available.";
    return resultOf(input, { status: "blocked", owner: row.owner, beforeSha256: currentHash, afterSha256: currentHash, evidence: selected.assessment?.diagnostics.map((item) => ({ kind: "capability", path: selected.root, sha256: currentHash, detail: item.message })) ?? [], reason: diagnostic });
  }

  if (input.operation === "reload") {
    return resultOf(input, { status: "skipped", owner: row.owner, beforeSha256: currentHash, afterSha256: currentHash, reason: "No process command is accepted by the host adapter; start a new OpenCode session to load the configured module." });
  }

  if (input.operation === "install" && input.manager === "managed-checkout") {
    const selected = await managedEngineForOperation(home, targetSha);
    if (selected.assessment?.compatible) {
      return resultOf(input, { status: "skipped", owner: row.owner, beforeSha256: currentHash, afterSha256: currentHash, evidence: [{ kind: "reuse", path: selected.root, sha256: await anyPathHash(selected.root!), detail: "Installed engine satisfies required interfaces; no engine/config/cache writes were made." }], reason: "Compatible engine reused." });
    }
    const installed = await ensureUpstream({ homeDir: home, preferredRoot: selected.root ?? undefined });
    const after = await anyPathHash(installed.path);
    if (!after) return resultOf(input, { status: "failed", owner: "lane-pilot", beforeSha256: currentHash, reason: "Managed engine installation completed without a readable path hash." });
    const snapshotId = await snapshotOfWrite({ home, manager: input.manager, path: installed.path, operation: "install", beforeSha256: null, afterSha256: after, ownedValue: null, sourceSha: installed.sha });
    return resultOf(input, { status: "ok", owner: "lane-pilot", path: installed.path, beforeSha256: null, afterSha256: after, snapshotId, evidence: [{ kind: "installed", path: installed.path, sha256: after, detail: `Immutable managed engine ${installed.sha} installed; adapted capabilities: ${installed.adaptedCapabilities.join(", ") || "none"}.` }], reason: null });
  }

  if (input.operation === "install" && input.manager === "opencode-plugin") {
    const state = await readTextState(input.path);
    if (state.text && isManagedOpenCodePlugin(state.text)) {
      return resultOf(input, { status: "skipped", owner: "lane-pilot", beforeSha256: state.sha256, afterSha256: state.sha256, reason: "Owned OpenCode shim is already installed; no write was made." });
    }
    if (state.text !== null) return resultOf(input, { status: "conflict", owner: row.owner, beforeSha256: state.sha256, afterSha256: state.sha256, reason: "OpenCode plugin path already exists and is not marked Lane Pilot-owned; it was preserved." });
    if (input.expectedSha256 !== null) return resultOf(input, { status: "conflict", owner: row.owner, beforeSha256: null, afterSha256: null, reason: "Expected a missing OpenCode plugin path; no write was made." });
    let selected = await managedEngineForOperation(home, targetSha);
    if (!selected.assessment?.compatible || !selected.root) {
      const installed = await ensureUpstream({ homeDir: home, preferredRoot: selected.root ?? undefined });
      selected = { root: installed.path, assessment: assessEngineCapabilities(await inspectEngineCapabilities(installed.path)) };
    }
    if (!selected.assessment?.compatible || !selected.root) {
      const reason = selected.assessment?.diagnostics[0]?.message ?? "No compatible OpenCode module source is available.";
      return resultOf(input, { status: "blocked", owner: row.owner, beforeSha256: null, afterSha256: null, reason });
    }
    const moduleSource = join(selected.root, "profiles/opencode/opencode-lane/index.ts");
    if (!await exists(moduleSource)) return resultOf(input, { status: "blocked", owner: row.owner, beforeSha256: null, afterSha256: null, reason: "Compatible engine does not contain profiles/opencode/opencode-lane/index.ts; impacted function: OpenCode plugin module loading." });
    const shim = createOpenCodePluginShim(selected.root, selected.assessment.adaptedCapabilities);
    const write = await compareAndSwapText(input.path, null, shim);
    if (write.status !== "ok" || !write.afterSha256) return resultOf(input, { status: write.status, owner: row.owner, beforeSha256: write.beforeSha256, afterSha256: write.afterSha256, reason: write.reason });
    const sourceSha = sourceShaOf(selected.root);
    const snapshotId = await snapshotOfWrite({ home, manager: input.manager, path: input.path, operation: "install", beforeSha256: null, afterSha256: write.afterSha256, ownedValue: null, sourceSha });
    return resultOf(input, { status: "ok", owner: "lane-pilot", beforeSha256: null, afterSha256: write.afterSha256, snapshotId, evidence: [{ kind: "installed", path: input.path, sha256: write.afterSha256, detail: `Managed shim imports the inspected compatible module at ${moduleSource}; source SHA ${sourceSha ?? "unavailable"} is provenance only.` }], reason: null });
  }

  if (input.operation === "connect" && input.manager === "opencode-config") {
    const pluginState = await inventoryForHome({ projectId: input.projectId, hostId: input.hostId, targetSha }, home);
    const pluginRow = pluginState.managers.find((item) => item.manager === "opencode-plugin");
    if (!pluginRow?.installed || !await exists(pluginRow.path)) return resultOf(input, { status: "blocked", owner: row.owner, beforeSha256: currentHash, afterSha256: currentHash, reason: "Install the managed OpenCode plugin shim before connecting the config." });
    const config = await readTextState(input.path);
    const configExists = await exists(input.path);
    if (config.text === null && configExists) return resultOf(input, { status: "blocked", owner: row.owner, beforeSha256: config.sha256, afterSha256: config.sha256, reason: "OpenCode config path exists but is not a readable regular file; it was preserved." });
    const configText = config.text ?? "{}\n";
    const parsed = config.text === null ? {} : await parseJsonc(input.path);
    const entries = pluginEntries(parsed);
    const oldRef = entries.find((entry) => entry.endsWith("lane-context.ts"));
    if (oldRef) {
      const oldPath = oldRef.startsWith("/") ? oldRef : join(home, ".config/opencode", oldRef.replace(/^\.\//, ""));
      if (await exists(oldPath)) return resultOf(input, { status: "conflict", owner: row.owner, beforeSha256: config.sha256, afterSha256: config.sha256, reason: `Existing legacy plugin ${oldRef} is present and not recorded as Lane Pilot-owned; removing it could duplicate or overwrite a user plugin.` });
    }
    const patched = ensureOpenCodePluginEntry(configText, OPENCODE_PLUGIN_REF);
    if (!patched.ok) return resultOf(input, { status: "blocked", owner: row.owner, beforeSha256: config.sha256, afterSha256: config.sha256, reason: patched.message });
    const write = await compareAndSwapText(input.path, config.sha256, patched.text);
    if (write.status !== "ok") return resultOf(input, { status: write.status, owner: row.owner, beforeSha256: write.beforeSha256, afterSha256: write.afterSha256, reason: write.reason });
    if (!write.changed || !write.afterSha256) return resultOf(input, { status: "skipped", owner: row.owner, beforeSha256: write.beforeSha256, afterSha256: write.afterSha256, reason: "OpenCode plugin entry is already present; no write was made." });
    let snapshotId: string;
    try {
      snapshotId = await snapshotOfWrite({ home, manager: input.manager, path: input.path, operation: "connect", beforeSha256: write.beforeSha256, afterSha256: write.afterSha256, ownedValue: OPENCODE_PLUGIN_REF, sourceSha: pluginRow.sourceSha });
    } catch (error) {
      const reverted = removeOpenCodePluginEntry(patched.text, OPENCODE_PLUGIN_REF);
      if (reverted.ok) await compareAndSwapText(input.path, write.afterSha256, reverted.text);
      return resultOf(input, { status: "failed", owner: row.owner, beforeSha256: write.beforeSha256, afterSha256: await anyPathHash(input.path), reason: `Ownership record failed; attempted CAS rollback. ${error instanceof Error ? error.message : String(error)}` });
    }
    return resultOf(input, { status: "ok", owner: "lane-pilot", beforeSha256: write.beforeSha256, afterSha256: write.afterSha256, snapshotId, evidence: [{ kind: "connected", path: input.path, sha256: write.afterSha256, detail: `Added only ${OPENCODE_PLUGIN_REF}; other plugin entries and JSONC trivia were preserved.` }], reason: null });
  }

  if (input.operation === "disconnect" && input.manager === "opencode-config") {
    const owned = (await readOwnershipLedger(home)).entries.find((item) => item.manager === input.manager && item.path === input.path && item.ownedValue === OPENCODE_PLUGIN_REF);
    if (!owned) return resultOf(input, { status: "skipped", owner: row.owner, beforeSha256: currentHash, afterSha256: currentHash, reason: "No Lane Pilot-owned OpenCode config entry is recorded; user config was not changed." });
    const config = await readTextState(input.path);
    if (!config.text) return resultOf(input, { status: "conflict", owner: row.owner, beforeSha256: config.sha256, afterSha256: config.sha256, reason: "Owned config path is absent or unreadable; no write was made." });
    const patched = removeOpenCodePluginEntry(config.text, OPENCODE_PLUGIN_REF);
    if (!patched.ok) return resultOf(input, { status: "blocked", owner: row.owner, beforeSha256: config.sha256, afterSha256: config.sha256, reason: patched.message });
    if (!patched.changed) return resultOf(input, { status: "skipped", owner: row.owner, beforeSha256: config.sha256, afterSha256: config.sha256, reason: "Owned plugin entry is already absent; no write was made." });
    const write = await compareAndSwapText(input.path, config.sha256, patched.text);
    if (write.status !== "ok") return resultOf(input, { status: write.status, owner: row.owner, beforeSha256: write.beforeSha256, afterSha256: write.afterSha256, reason: write.reason });
    const snapshotId = await snapshotOfWrite({ home, manager: input.manager, path: input.path, operation: "disconnect", beforeSha256: write.beforeSha256, afterSha256: write.afterSha256 ?? config.sha256!, ownedValue: OPENCODE_PLUGIN_REF, sourceSha: owned.sourceSha });
    await removeOwnershipEntry(home, input.manager, input.path);
    return resultOf(input, { status: "ok", owner: "lane-pilot", beforeSha256: write.beforeSha256, afterSha256: write.afterSha256, snapshotId, evidence: [{ kind: "disconnected", path: input.path, sha256: write.afterSha256, detail: `Removed only owned plugin entry ${OPENCODE_PLUGIN_REF}; later user fields and foreign entries were retained.` }], reason: null });
  }

  if (input.operation === "rollback") {
    if (!input.snapshotId) return resultOf(input, { status: "blocked", owner: row.owner, beforeSha256: currentHash, afterSha256: currentHash, reason: "snapshotId is required for rollback." });
    const snapshot = await readSnapshot(home, input.snapshotId);
    if (!snapshot || snapshot.path !== input.path || snapshot.manager !== input.manager) return resultOf(input, { status: "blocked", owner: row.owner, beforeSha256: currentHash, afterSha256: currentHash, reason: "Snapshot is missing or does not own this manager/path pair." });
    if (snapshot.operation === "connect" || snapshot.operation === "disconnect") {
      const config = await readTextState(input.path);
      if (!config.text || !snapshot.ownedValue) return resultOf(input, { status: "conflict", owner: row.owner, beforeSha256: config.sha256, afterSha256: config.sha256, reason: "Config is absent or its owned entry is unavailable; no rollback write was made." });
      if (snapshot.operation === "connect" && snapshot.beforeSha256 === null && config.sha256 === snapshot.afterSha256) {
        const removal = await removeOwnedPath(input.path, input.expectedSha256 ?? null);
        if (removal.status !== "ok") return resultOf(input, { status: removal.status, owner: "lane-pilot", beforeSha256: removal.before, afterSha256: removal.after, reason: removal.reason });
        await removeOwnershipEntry(home, input.manager, input.path);
        return resultOf(input, { status: "rolled_back", owner: "lane-pilot", beforeSha256: removal.before, afterSha256: removal.after, snapshotId: input.snapshotId, evidence: [{ kind: "rollback", path: input.path, sha256: removal.after, detail: "Removed the config file created by this connect operation because its after hash still matched exactly." }], reason: null });
      }
      const patch = snapshot.operation === "connect"
        ? removeOpenCodePluginEntry(config.text, snapshot.ownedValue)
        : ensureOpenCodePluginEntry(config.text, snapshot.ownedValue);
      if (!patch.ok) return resultOf(input, { status: "blocked", owner: row.owner, beforeSha256: config.sha256, afterSha256: config.sha256, reason: patch.message });
      if (!patch.changed) return resultOf(input, { status: "skipped", owner: row.owner, beforeSha256: config.sha256, afterSha256: config.sha256, reason: "The owned config entry is already in its pre-operation state." });
      const write = await compareAndSwapText(input.path, config.sha256, patch.text);
      if (write.status !== "ok") return resultOf(input, { status: write.status, owner: row.owner, beforeSha256: write.beforeSha256, afterSha256: write.afterSha256, reason: write.reason });
      if (snapshot.operation === "connect") await removeOwnershipEntry(home, input.manager, input.path);
      else if (write.afterSha256) await addOwnershipEntry(home, { manager: input.manager, path: input.path, ownedValue: snapshot.ownedValue, owner: "lane-pilot", afterSha256: write.afterSha256, snapshotId: snapshot.snapshotId, sourceSha: snapshot.sourceSha });
      return resultOf(input, { status: "rolled_back", owner: "lane-pilot", beforeSha256: write.beforeSha256, afterSha256: write.afterSha256, snapshotId: input.snapshotId, evidence: [{ kind: "rollback", path: input.path, sha256: write.afterSha256, detail: "Rollback merged the owned plugin entry into the current JSONC and retained later user fields/comments." }], reason: null });
    }
    if (snapshot.operation === "install") {
      const removal = await removeOwnedPath(input.path, input.expectedSha256 ?? null);
      if (removal.status !== "ok") return resultOf(input, { status: removal.status, owner: "lane-pilot", beforeSha256: removal.before, afterSha256: removal.after, reason: removal.reason });
      await removeOwnershipEntry(home, input.manager, input.path);
      return resultOf(input, { status: "rolled_back", owner: "lane-pilot", beforeSha256: removal.before, afterSha256: removal.after, snapshotId: input.snapshotId, evidence: [{ kind: "rollback", path: input.path, sha256: removal.after, detail: "Removed the Lane Pilot-owned path only after its current hash matched the saved after hash." }], reason: null });
    }
  }

  if (["agents-marker", "claude-cache", "claude-settings"].includes(input.manager)) {
    return resultOf(input, { status: "skipped", owner: row.owner, beforeSha256: currentHash, afterSha256: currentHash, reason: "This manager is inventory-only in Lane Pilot coexistence; the adapter never rewrites Claude settings, Claude caches, or the shared install marker." });
  }

  return resultOf(input, { status: "blocked", owner: row.owner, beforeSha256: currentHash, afterSha256: currentHash, reason: `Unsupported operation ${input.operation} for manager ${input.manager}; no write was made.` });
}

import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TARGET_SHA } from "../../src/constants";
import { hashPath } from "../../src/hash";
import { inventoryCoexistenceAtHome, runCoexistenceOperation, runCoexistenceOperationAtHome } from "../../src/coexistence";
import { addOwnershipEntry, newSnapshotId, ownershipLedgerPath, readOwnershipLedger, readSnapshot, saveSnapshot } from "../../src/coexistence/ownership";
import { managedEngineDir } from "../../src/paths";
import { finalizeSnapshotAfter, rollbackSnapshot, takeSnapshot, verifyRollback } from "../../src/snapshot";
import { detectStack, installStack } from "../../src/stack-ops";

const homes: string[] = [];
const originalHome = process.env.HOME;
const hostId = process.env.BB_HOST_ID ?? "host_test";

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "lane-pilot-coexistence-"));
  homes.push(home);
  process.env.HOME = home;
  return home;
}

async function seedCompatibleEngine(root: string, missing: string[] = []): Promise<void> {
  const write = async (path: string, text: string) => {
    const full = join(root, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, text);
  };
  const files: Array<[string, string, string]> = [
    ["opencode.plugin.default_export", "profiles/opencode/opencode-lane.ts", "export { default } from './opencode-lane/index.ts';\n"],
    ["opencode.hook.event", "profiles/opencode/opencode-lane/index.ts", "event: async () => {}\n"],
    ["opencode.hook.chat_message", "profiles/opencode/opencode-lane/index.ts", "\"chat.message\": async () => {}\n"],
    ["opencode.hook.chat_params", "profiles/opencode/opencode-lane/index.ts", "\"chat.params\": async () => {}\n"],
    ["opencode.hook.tool_execute_after", "profiles/opencode/opencode-lane/index.ts", "\"tool.execute.after\": async () => {}\n"],
    ["opencode.hook.messages_transform", "profiles/opencode/opencode-lane/index.ts", "\"experimental.chat.messages.transform\": async () => {}\n"],
    ["opencode.telemetry.session_compacted", "profiles/opencode/opencode-lane/telemetry.ts", "export function createTelemetry() { return { event: async () => { if (\"session.compacted\") return; }, after: async () => ({}) }; }\n"],
    ["opencode.sticky.contract_recovery", "profiles/opencode/opencode-lane/sticky.ts", "export function ensureStickyMessages(messages: unknown[], block: string) { if (block) messages.push(block); }\n"],
    ["opencode.sticky.dumped_tool_recovery", "profiles/opencode/opencode-lane/sticky.ts", "export function dumpedToolNote(text: string) { return text ? \"note\" : \"\"; }\n"],
    ["opencode.native_tool_route", "bin/lane-session", "export CURSOR_ACP_FORWARD_TOOL_CALLS=false\n"],
    ["execution_packet.line_windows", "bin/execution_packet.py", "_WINDOW_RE = None\n"],
  ];
  const combined = new Map<string, string>();
  for (const [capability, path, content] of files) {
    if (missing.includes(capability)) continue;
    const separator = path === "profiles/opencode/opencode-lane/index.ts" ? ",\n" : "\n";
    combined.set(path, `${combined.get(path) ?? ""}${combined.has(path) ? separator : ""}${content.trim()}`);
  }
  for (const [path, content] of combined) await write(path, content);
  await write("profiles/opencode/opencode-lane.ts", `export { default } from "./opencode-lane/index.ts";\n`);
  const hooks = [...combined.entries()]
    .filter(([path]) => path === "profiles/opencode/opencode-lane/index.ts")
    .map(([, content]) => content)
    .join("");
  await write("profiles/opencode/opencode-lane/index.ts", `export const OpenCodeLanePlugin = async () => ({\n${hooks}\n});\nexport default OpenCodeLanePlugin;\n`);
  await write("package.json", '{"version":"99.0.0-custom"}\n');
}

async function makeGitRepo(root: string): Promise<void> {
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync("git", ["-C", root, "-c", "user.name=AG-251 test", "-c", "user.email=ag251@example.invalid", "add", "-A"]);
  execFileSync("git", ["-C", root, "-c", "user.name=AG-251 test", "-c", "user.email=ag251@example.invalid", "commit", "--quiet", "-m", "fixture"]);
}

async function inventory(home: string) {
  return inventoryCoexistenceAtHome({ projectId: "proj_test", hostId, targetSha: TARGET_SHA }, home);
}

async function treeHash(path: string): Promise<string | null> {
  try { return (await hashPath(path)).sha256; } catch { return null; }
}

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

describe("typed coexistence operations", () => {
  it("snapshots only owned guard files without probing external operations", async () => {
    const home = await makeHome();
    const settingsPath = join(home, ".claude/settings.json");
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(settingsPath, '{"hooks":{}}\n');
    const snapshot = await takeSnapshot({ homeDir: home, additionalPaths: [settingsPath], includeManifest: false });
    expect(snapshot.entries.map((entry) => entry.path)).toEqual([settingsPath]);
    await finalizeSnapshotAfter(snapshot, home);
    expect(await treeHash(join(home, ".claude/backups"))).toBeNull();
  });

  it("reuses a newer compatible custom source with zero engine, config, or cache writes", async () => {
    const home = await makeHome();
    const custom = join(home, ".claude/plugins/cache/claude-lane-stack/lane-stack/99.0.0-custom");
    await seedCompatibleEngine(custom);
    await mkdir(join(home, ".agents"), { recursive: true });
    await writeFile(join(home, ".agents/install.json"), `${JSON.stringify({ source_sha: "custom-main-sha", source_repo: custom, version: "99.0.0-custom" })}\n`);
    await mkdir(join(home, ".config/opencode"), { recursive: true });
    const configPath = join(home, ".config/opencode/opencode.jsonc");
    await writeFile(configPath, '{\n  "model": "user/model",\n  "plugin": ["./plugins/other.ts"]\n}\n');
    const before = {
      custom: await treeHash(custom),
      config: await treeHash(configPath),
      cache: await treeHash(join(home, ".claude/plugins/cache")),
      managed: await treeHash(managedEngineDir(TARGET_SHA, home)),
    };
    const detected = await detectStack({ requestedHostId: hostId, homeDir: home });
    expect(detected.compatibility).toMatchObject({ compatible: true, decision: "reuse" });
    const stackInstall = await installStack({ requestedHostId: hostId, homeDir: home });
    expect(stackInstall.exitCode).toBe(0);
    expect(stackInstall.filesChanged).toEqual([]);
    const result = await inventory(home);
    const cache = result.managers.find((row) => row.manager === "claude-cache");
    expect(cache?.compatible).toBe(true);
    expect(cache?.decision).toBe("reuse");
    expect(cache?.sourceSha).not.toBe(TARGET_SHA);
    const managedPath = managedEngineDir(TARGET_SHA, home);
    const operation = await runCoexistenceOperation({
      projectId: "proj_test", hostId, operation: "install", manager: "managed-checkout",
      path: managedPath, expectedSha256: null, targetSha: TARGET_SHA,
    });
    expect(operation.status).toBe("skipped");
    expect(operation.reason).toContain("Compatible engine reused");
    expect({
      custom: await treeHash(custom),
      config: await treeHash(configPath),
      cache: await treeHash(join(home, ".claude/plugins/cache")),
      managed: await treeHash(managedPath),
    }).toEqual(before);
  });

  it("preserves compatible custom state and reports an exact missing interface for incompatible engines", async () => {
    const home = await makeHome();
    const custom = join(home, ".agents/custom-lane-stack");
    await seedCompatibleEngine(custom, ["opencode.hook.tool_execute_after"]);
    await mkdir(join(home, ".agents"), { recursive: true });
    await writeFile(join(home, ".agents/install.json"), `${JSON.stringify({ source_sha: "custom-dirty-sha", source_repo: custom, version: "custom" })}\n`);
    const before = await treeHash(custom);
    const result = await inventory(home);
    const marker = result.managers.find((row) => row.manager === "agents-marker");
    expect(marker?.compatible).toBe(false);
    expect(marker?.missingCapabilities).toEqual(["opencode.hook.tool_execute_after"]);
    expect(marker?.evidence.some((item) => item.kind === "capability" && item.detail.includes("OpenCode tool evidence, budget, and winnow result handling"))).toBe(true);
    expect(await treeHash(custom)).toBe(before);
  });

  it("isolates an incompatible legacy install and keeps user engine/config/cache unchanged", async () => {
    const home = await makeHome();
    const incompatible = join(home, ".agents/custom-lane-stack");
    const compatibleFallback = join(home, "fixture-compatible-engine");
    await seedCompatibleEngine(incompatible, ["opencode.hook.tool_execute_after"]);
    await seedCompatibleEngine(compatibleFallback);
    await mkdir(join(home, ".agents"), { recursive: true });
    await writeFile(join(home, ".agents/install.json"), `${JSON.stringify({ source_sha: "custom-dirty-sha", source_repo: incompatible, version: "custom" })}\n`);
    await mkdir(join(home, ".claude/plugins/cache/claude-lane-stack/lane-stack/custom"), { recursive: true });
    await writeFile(join(home, ".claude/settings.json"), '{"hooks":{"UserHook":"keep"}}\n');
    await mkdir(join(home, ".config/opencode"), { recursive: true });
    await writeFile(join(home, ".config/opencode/opencode.jsonc"), '{\n  // user\n  "model": "custom/model",\n  "plugin": ["./plugins/other.ts"]\n}\n');
    await writeFile(join(compatibleFallback, "install.sh"), `#!/bin/sh\nprintf leaked > "$HOME/.agents/legacy-installer-leak"\n`);
    await makeGitRepo(compatibleFallback);

    const before = {
      incompatible: await treeHash(incompatible),
      marker: await treeHash(join(home, ".agents/install.json")),
      claude: await treeHash(join(home, ".claude")),
      opencode: await treeHash(join(home, ".config/opencode")),
      cache: await treeHash(join(home, ".claude/plugins/cache")),
    };
    const receipt = await installStack({ requestedHostId: hostId, homeDir: home, localFallbackPath: compatibleFallback });

    expect(receipt.exitCode, receipt.notes.join("\n")).toBe(0);
    expect(receipt.notes.join("\n").toLowerCase()).toContain("no install.sh");
    expect(receipt.sourceSha).toBeTruthy();
    expect(await treeHash(join(home, ".agents/legacy-installer-leak"))).toBeNull();
    expect({
      incompatible: await treeHash(incompatible),
      marker: await treeHash(join(home, ".agents/install.json")),
      claude: await treeHash(join(home, ".claude")),
      opencode: await treeHash(join(home, ".config/opencode")),
      cache: await treeHash(join(home, ".claude/plugins/cache")),
    }).toEqual(before);
  });

  it("returns conflict without writing when the expected config hash is stale", async () => {
    const home = await makeHome();
    const configPath = join(home, ".config/opencode/opencode.json");
    await mkdir(join(home, ".config/opencode"), { recursive: true });
    await writeFile(configPath, '{"plugin": ["./plugins/other.ts"]}\n');
    const before = await readFile(configPath, "utf8");
    const operation = await runCoexistenceOperation({
      projectId: "proj_test", hostId, operation: "connect", manager: "opencode-config",
      path: configPath, expectedSha256: "0".repeat(64), targetSha: TARGET_SHA,
    });
    expect(operation.status).toBe("conflict");
    expect(operation.beforeSha256).not.toBe("0".repeat(64));
    expect(operation.afterSha256).toBe(operation.beforeSha256);
    expect(await readFile(configPath, "utf8")).toBe(before);
  });

  it("inventories and rolls back an alternate managed engine path", async () => {
    const home = await makeHome();
    const variant = managedEngineDir(`${TARGET_SHA}-managed-existing`, home);
    await seedCompatibleEngine(variant);
    const afterSha = (await hashPath(variant)).sha256;
    if (!afterSha) throw new Error("fixture tree should have a SHA-256");
    const snapshotId = newSnapshotId();
    await saveSnapshot(home, {
      snapshotId,
      manager: "managed-checkout",
      path: variant,
      operation: "install",
      owner: "lane-pilot",
      beforeSha256: null,
      afterSha256: afterSha,
      ownedValue: null,
      sourceSha: TARGET_SHA,
    });
    const rows = await inventory(home);
    expect(rows.managers.some((row) => row.manager === "managed-checkout" && row.path === variant && row.compatible)).toBe(true);
    const rollback = await runCoexistenceOperation({
      projectId: "proj_test", hostId, operation: "rollback", manager: "managed-checkout",
      path: variant, expectedSha256: afterSha, snapshotId, targetSha: TARGET_SHA,
    });
    expect(rollback.status).toBe("rolled_back");
    expect(await treeHash(variant)).toBeNull();
  });

  it("refuses whole-snapshot rollback over late Claude settings and managed-tree edits", async () => {
    const home = await makeHome();
    const settingsPath = join(home, ".claude/settings.json");
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(settingsPath, '{"theme":"before"}\n');
    const snapshot = await takeSnapshot({ homeDir: home });
    await writeFile(settingsPath, '{"theme":"installed"}\n');
    const binPath = join(home, ".agents/bin");
    await mkdir(binPath, { recursive: true });
    const toolPath = join(binPath, "lane-tool");
    await writeFile(toolPath, "installed\n");
    await finalizeSnapshotAfter(snapshot, home);
    await writeFile(settingsPath, '{"theme":"late-user-edit"}\n');
    await writeFile(toolPath, "late-user-tool-edit\n");

    const rollback = await rollbackSnapshot(snapshot.snapshotPath);
    expect(rollback.conflicts.map((item) => item.path)).toContain(settingsPath);
    expect(rollback.conflicts.map((item) => item.path)).toContain(binPath);
    expect(await readFile(settingsPath, "utf8")).toContain("late-user-edit");
    expect(await readFile(toolPath, "utf8")).toBe("late-user-tool-edit\n");
    expect((await verifyRollback(snapshot.snapshotPath)).ok).toBe(false);
  });

  it("CAS-creates a minimal OpenCode config when explicit connect finds no config", async () => {
    const home = await makeHome();
    const engine = join(home, ".agents/custom-lane-stack");
    await seedCompatibleEngine(engine);
    await mkdir(join(home, ".agents"), { recursive: true });
    await writeFile(join(home, ".agents/install.json"), `${JSON.stringify({ source_sha: "custom-main-sha", source_repo: engine, version: "99.0.0-custom" })}\n`);
    const pluginPath = join(home, ".config/opencode/plugins/opencode-lane.ts");
    const install = await runCoexistenceOperation({
      projectId: "proj_test", hostId, operation: "install", manager: "opencode-plugin",
      path: pluginPath, expectedSha256: null, targetSha: TARGET_SHA,
    });
    expect(install.status).toBe("ok");
    const initial = await inventory(home);
    const config = initial.managers.find((row) => row.manager === "opencode-config");
    expect(config?.sha256).toBeNull();
    const connect = await runCoexistenceOperation({
      projectId: "proj_test", hostId, operation: "connect", manager: "opencode-config",
      path: config!.path, expectedSha256: null, targetSha: TARGET_SHA,
    });
    expect(connect.status).toBe("ok");
    expect(connect.beforeSha256).toBeNull();
    expect(connect.afterSha256).toBeTruthy();
    const created = await readFile(config!.path, "utf8");
    expect(created).toContain("./plugins/opencode-lane.ts");
    expect(created).not.toContain("model");
    const connected = await inventory(home);
    const connectedConfig = connected.managers.find((row) => row.manager === "opencode-config");
    const rollback = await runCoexistenceOperation({
      projectId: "proj_test", hostId, operation: "rollback", manager: "opencode-config",
      path: config!.path, expectedSha256: connectedConfig?.sha256 ?? null,
      snapshotId: connect.snapshotId, targetSha: TARGET_SHA,
    });
    expect(rollback.status).toBe("rolled_back");
    expect(await treeHash(config!.path)).toBeNull();
  });

  it("installs and disconnects only the owned OpenCode entry while preserving late user edits", async () => {
    const home = await makeHome();
    const engine = join(home, ".agents/custom-lane-stack");
    await seedCompatibleEngine(engine);
    await mkdir(join(home, ".agents"), { recursive: true });
    await writeFile(join(home, ".agents/install.json"), `${JSON.stringify({ source_sha: "custom-main-sha", source_repo: engine, version: "99.0.0-custom" })}\n`);
    await mkdir(join(home, ".config/opencode"), { recursive: true });
    const configPath = join(home, ".config/opencode/opencode.jsonc");
    await writeFile(configPath, '{\n  // user comment\n  "model": "user/model",\n  "plugin": ["./plugins/other.ts"]\n}\n');
    const pluginPath = join(home, ".config/opencode/plugins/opencode-lane.ts");
    const install = await runCoexistenceOperation({
      projectId: "proj_test", hostId, operation: "install", manager: "opencode-plugin",
      path: pluginPath, expectedSha256: null, targetSha: TARGET_SHA,
    });
    expect(install.status).toBe("ok");
    expect(install.snapshotId).toBeTruthy();

    let current = await inventory(home);
    const configState = current.managers.find((row) => row.manager === "opencode-config");
    const connect = await runCoexistenceOperation({
      projectId: "proj_test", hostId, operation: "connect", manager: "opencode-config",
      path: configPath, expectedSha256: configState?.sha256 ?? null, targetSha: TARGET_SHA,
    });
    expect(connect.status).toBe("ok");
    expect(connect.snapshotId).toBeTruthy();
    const connectedText = await readFile(configPath, "utf8");
    const lateEdit = connectedText.trimEnd().replace(/\}\s*$/, `,\n  // concurrent user edit\n  "theme": "dark"\n}\n`);
    await writeFile(configPath, lateEdit);

    current = await inventory(home);
    const latest = current.managers.find((row) => row.manager === "opencode-config");
    const disconnect = await runCoexistenceOperation({
      projectId: "proj_test", hostId, operation: "disconnect", manager: "opencode-config",
      path: configPath, expectedSha256: latest?.sha256 ?? null, targetSha: TARGET_SHA,
    });
    expect(disconnect.status).toBe("ok");
    const finalConfig = await readFile(configPath, "utf8");
    expect(finalConfig).toContain("user comment");
    expect(finalConfig).toContain("./plugins/other.ts");
    expect(finalConfig).toContain("concurrent user edit");
    expect(finalConfig).toContain('"theme": "dark"');
    expect(finalConfig).not.toContain("./plugins/opencode-lane.ts");
  });

  it("preserves ambiguous duplicate OpenCode entries added after connect", async () => {
    const home = await makeHome();
    const engine = join(home, ".agents/custom-lane-stack");
    await seedCompatibleEngine(engine);
    await mkdir(join(home, ".agents"), { recursive: true });
    await writeFile(join(home, ".agents/install.json"), `${JSON.stringify({ source_sha: "custom-main-sha", source_repo: engine, version: "99.0.0-custom" })}\n`);
    await mkdir(join(home, ".config/opencode"), { recursive: true });
    const configPath = join(home, ".config/opencode/opencode.jsonc");
    await writeFile(configPath, '{\n  "plugin": ["./plugins/other.ts"]\n}\n');
    const pluginPath = join(home, ".config/opencode/plugins/opencode-lane.ts");
    const install = await runCoexistenceOperation({
      projectId: "proj_test", hostId, operation: "install", manager: "opencode-plugin",
      path: pluginPath, expectedSha256: null, targetSha: TARGET_SHA,
    });
    expect(install.status).toBe("ok");
    const initial = await inventory(home);
    const configRow = initial.managers.find((row) => row.manager === "opencode-config");
    const connect = await runCoexistenceOperation({
      projectId: "proj_test", hostId, operation: "connect", manager: "opencode-config",
      path: configPath, expectedSha256: configRow?.sha256 ?? null, targetSha: TARGET_SHA,
    });
    expect(connect.status).toBe("ok");
    const connected = await readFile(configPath, "utf8");
    const duplicate = connected.replace('"./plugins/opencode-lane.ts"', '"./plugins/opencode-lane.ts", "./plugins/opencode-lane.ts"');
    await writeFile(configPath, duplicate);

    const latest = await inventory(home);
    const latestRow = latest.managers.find((row) => row.manager === "opencode-config");
    const disconnect = await runCoexistenceOperation({
      projectId: "proj_test", hostId, operation: "disconnect", manager: "opencode-config",
      path: configPath, expectedSha256: latestRow?.sha256 ?? null, targetSha: TARGET_SHA,
    });
    expect(disconnect.status).toBe("blocked");
    expect(disconnect.reason).toContain("multiple matching plugin entries make ownership ambiguous");
    expect(await readFile(configPath, "utf8")).toBe(duplicate);
  });

  it.each([
    { marker: "absent", foreignGuard: false },
    { marker: "absent", foreignGuard: true },
    { marker: "corrupt", foreignGuard: true },
    { marker: "corrupt", foreignGuard: false },
    { marker: "incompatible", foreignGuard: true },
    { marker: "incompatible", foreignGuard: false },
  ] as const)("keeps ordinary configs and adapts PM for $marker marker / foreign guard=$foreignGuard", async ({ marker, foreignGuard }) => {
    const home = await makeHome();
    const pmWorkspace = join(home, "pm-workspace");
    const homeClaude = join(home, ".claude/settings.json");
    const homeOpenCode = join(home, ".config/opencode/opencode.json");
    const pmSettings = join(pmWorkspace, ".claude/settings.json");
    const foreignGuardPath = join(home, ".agents/hooks/guard_shell.py");
    const ownedGuardPath = join(home, ".agents/lane-pilot/pm/guard_shell.py");
    const markerPath = join(home, ".agents/install.json");
    const fallback = join(home, "fixture-compatible-engine");

    await seedCompatibleEngine(fallback);
    await makeGitRepo(fallback);
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(homeClaude, '{"hooks":{"UserHook":"keep"},"theme":"dark"}\n');
    await mkdir(join(home, ".config/opencode"), { recursive: true });
    await writeFile(homeOpenCode, '{"model":"user/model","plugin":["./plugins/user.ts"]}\n');
    await mkdir(join(pmWorkspace, ".claude"), { recursive: true });
    await writeFile(pmSettings, `{\n  // keep this user's comment\n  "model": "pm/model",\n  "hooks": {\n    "PreToolUse": [{"matcher":"Bash","hooks":[{"type":"command","command":"python3 /user/guard.py"}]}]\n  }\n}\n`);

    if (marker === "corrupt") {
      await mkdir(join(home, ".agents"), { recursive: true });
      await writeFile(markerPath, '{broken marker\n');
    } else if (marker === "incompatible") {
      const custom = join(home, ".agents/custom-lane-stack");
      await seedCompatibleEngine(custom, ["opencode.hook.tool_execute_after"]);
      await mkdir(join(home, ".agents"), { recursive: true });
      await writeFile(markerPath, `${JSON.stringify({ source_sha: "user-custom-incompatible", source_repo: custom, version: "custom" })}\n`);
    }
    if (foreignGuard) {
      await mkdir(join(home, ".agents/hooks"), { recursive: true });
      await writeFile(foreignGuardPath, "foreign-user-guard\n");
    }

    const protectedBefore = {
      claude: await treeHash(homeClaude),
      opencode: await treeHash(homeOpenCode),
      marker: await treeHash(markerPath),
      foreignGuard: await treeHash(foreignGuardPath),
    };
    const ctx = {
      requestedHostId: hostId,
      homeDir: home,
      localFallbackPath: fallback,
      pmWorkspacePath: pmWorkspace,
      guardSourcePath: join(process.cwd(), "lane-stack/hooks/guard_shell.py"),
      moduleUrl: import.meta.url,
    };
    const receipt = await installStack(ctx);
    expect(receipt.exitCode, receipt.notes.join("\n")).toBe(0);
    expect(receipt.scenario).toBe("S1");
    expect(await treeHash(ownedGuardPath)).toBeTruthy();
    expect(await readFile(ownedGuardPath, "utf8")).toContain("LANE_PILOT_PM_AGENT_TYPES");
    expect(await treeHash(foreignGuardPath)).toBe(protectedBefore.foreignGuard);
    expect({
      claude: await treeHash(homeClaude),
      opencode: await treeHash(homeOpenCode),
      marker: await treeHash(markerPath),
      foreignGuard: await treeHash(foreignGuardPath),
    }).toEqual(protectedBefore);

    const configured = await readFile(pmSettings, "utf8");
    expect(configured).toContain("// keep this user's comment");
    expect(configured).toContain('"model": "pm/model"');
    expect(configured).toContain("python3 /user/guard.py");
    expect(configured).toContain(`python3 '${ownedGuardPath}'`);
    expect(configured.match(/python3 '\/.*lane-pilot\/pm\/guard_shell\.py'/g)).toHaveLength(1);

    const settingsAfterFirst = await treeHash(pmSettings);
    const repeated = await installStack(ctx);
    expect(repeated.exitCode, repeated.notes.join("\n")).toBe(0);
    expect(repeated.scenario).toBe("S1");
    expect(repeated.filesChanged).toEqual([]);
    expect(await treeHash(pmSettings)).toBe(settingsAfterFirst);
  });
});

const exactDd77Fixture = [
  join(process.cwd(), "../../.agency/jobs/AG-252/tmp/upstream-ref"),
  join(process.cwd(), "../upstream-ref"),
].find(existsSync);

async function incompatibleFallback(home: string): Promise<string> {
  if (!exactDd77Fixture) throw new Error("Exact dd77 test fixture is unavailable.");
  const fallback = join(home, "dirty-source");
  execFileSync("git", ["clone", "--local", "--quiet", exactDd77Fixture, fallback]);
  const hookPath = join(fallback, "profiles/opencode/opencode-lane/index.ts");
  const hook = await readFile(hookPath, "utf8");
  await writeFile(hookPath, hook.replace('"tool.execute.after"', '"tool.execute.missing"'));
  return fallback;
}

async function managedInstall(
  home: string,
  fallback: string,
  faultAt?: "after-rename" | "after-snapshot" | "after-ledger-commit" | "rollback-conflict",
  beforeCompensation?: (managedPath: string) => Promise<void>,
) {
  const row = (await inventory(home)).managers.find((item) => item.manager === "managed-checkout");
  if (!row) throw new Error("managed checkout inventory row is missing");
  return runCoexistenceOperationAtHome({
    projectId: "proj_test",
    hostId,
    operation: "install",
    manager: "managed-checkout",
    path: row.path,
    expectedSha256: row.sha256,
    targetSha: TARGET_SHA,
  }, home, { localFallbackPath: fallback, faultAt, beforeCompensation });
}

describe("managed install transaction failure integrity", () => {
  it.each(["after-rename", "after-snapshot", "after-ledger-commit"] as const)("compensates and safely retries after %s", async (faultAt) => {
    const home = await makeHome();
    const fallback = await incompatibleFallback(home);
    const claude = join(home, ".claude/settings.json");
    const openCode = join(home, ".config/opencode/opencode.json");
    await mkdir(join(home, ".claude"), { recursive: true });
    await mkdir(join(home, ".config/opencode"), { recursive: true });
    await writeFile(claude, '{"env":{"KEEP":"yes"}}\n');
    await writeFile(openCode, '{"model":"user/model"}\n');
    const ordinaryBefore = { claude: await treeHash(claude), openCode: await treeHash(openCode) };
    let preexistingSnapshotIds: string[] = [];
    if (faultAt === "after-ledger-commit") {
      const existingSnapshotId = newSnapshotId();
      const configHash = await treeHash(openCode);
      if (!configHash) throw new Error("OpenCode fixture should have a hash");
      await saveSnapshot(home, {
        snapshotId: existingSnapshotId,
        manager: "opencode-config",
        path: openCode,
        operation: "connect",
        owner: "lane-pilot",
        beforeSha256: null,
        afterSha256: configHash,
        ownedValue: "./plugins/other.ts",
        sourceSha: TARGET_SHA,
      });
      await addOwnershipEntry(home, {
        manager: "opencode-config",
        path: openCode,
        ownedValue: "./plugins/other.ts",
        owner: "lane-pilot",
        afterSha256: configHash,
        snapshotId: existingSnapshotId,
        sourceSha: TARGET_SHA,
      });
      preexistingSnapshotIds = await readdir(join(home, ".agents/lane-pilot/coexistence/snapshots"));
    }
    const ledgerBefore = await treeHash(ownershipLedgerPath(home));

    const failed = await managedInstall(home, fallback, faultAt);
    expect(failed.status, failed.reason ?? "").toBe("failed");
    expect(failed.reason).toContain("compensation completed");
    expect(failed.evidence).toEqual([]);
    expect((await readOwnershipLedger(home)).entries.filter((entry) => entry.manager === "managed-checkout")).toEqual([]);
    const snapshots = await readdir(join(home, ".agents/lane-pilot/coexistence/snapshots")).catch(() => []);
    expect(snapshots).toEqual(preexistingSnapshotIds);
    expect(await treeHash(ownershipLedgerPath(home))).toBe(ledgerBefore);
    const engines = await readdir(join(home, ".agents/lane-pilot/engines")).catch(() => []);
    expect(engines.filter((name) => name.startsWith(TARGET_SHA))).toEqual([]);
    expect({ claude: await treeHash(claude), openCode: await treeHash(openCode) }).toEqual(ordinaryBefore);

    const retry = await managedInstall(home, fallback);
    expect(retry.status, retry.reason ?? "").toBe("ok");
    expect(retry.path).toContain("/.agents/lane-pilot/engines/");
    expect(retry.snapshotId).toBeTruthy();
    const entry = (await readOwnershipLedger(home)).entries.find((item) => item.path === retry.path);
    expect(entry?.snapshotId).toBe(retry.snapshotId);
    expect(await readSnapshot(home, retry.snapshotId!)).toMatchObject({ path: retry.path, afterSha256: retry.afterSha256 });
    expect({ claude: await treeHash(claude), openCode: await treeHash(openCode) }).toEqual(ordinaryBefore);
  }, 180_000);

  it("fails closed on malformed ownership metadata before rename and reports no false writes", async () => {
    const home = await makeHome();
    const fallback = await incompatibleFallback(home);
    const ledger = ownershipLedgerPath(home);
    await mkdir(join(home, ".agents/lane-pilot/coexistence"), { recursive: true });
    await writeFile(ledger, "{invalid\n");
    const claude = join(home, ".claude/settings.json");
    const openCode = join(home, ".config/opencode/opencode.json");
    await mkdir(join(home, ".claude"), { recursive: true });
    await mkdir(join(home, ".config/opencode"), { recursive: true });
    await writeFile(claude, '{"env":{"KEEP":"yes"}}\n');
    await writeFile(openCode, '{"model":"user/model"}\n');
    const ordinaryBefore = { claude: await treeHash(claude), openCode: await treeHash(openCode) };

    const receipt = await installStack({ requestedHostId: hostId, homeDir: home, localFallbackPath: fallback });
    expect(receipt.status).toBe("failed");
    expect(receipt.filesChanged).toEqual([]);
    expect(receipt.notes.join("\n")).toContain("Ownership metadata preflight failed");
    expect(receipt.notes.join("\n")).not.toContain("failed before a write");
    expect(await treeHash(managedEngineDir(TARGET_SHA, home))).toBeNull();
    expect(await readdir(join(home, ".agents/lane-pilot/coexistence/snapshots")).catch(() => [])).toEqual([]);
    expect(await readFile(ledger, "utf8")).toBe("{invalid\n");
    expect({ claude: await treeHash(claude), openCode: await treeHash(openCode) }).toEqual(ordinaryBefore);
  }, 180_000);

  it("preserves a changed rollback path and retries at a fresh managed destination", async () => {
    const home = await makeHome();
    const fallback = await incompatibleFallback(home);
    const failed = await managedInstall(home, fallback, "rollback-conflict", async (path) => {
      await writeFile(join(path, ".late-user-edit"), "preserve this concurrent edit\n", { flag: "wx" });
    });
    expect(failed.status).toBe("failed");
    expect(failed.reason).toContain("residual path(s)");
    expect(failed.reason).toContain("Rollback conflict");
    const orphan = failed.path;
    expect(await readFile(join(orphan, ".late-user-edit"), "utf8")).toBe("preserve this concurrent edit\n");
    const orphanBeforeRetry = await treeHash(orphan);
    expect(failed.evidence.some((item) => item.kind === "rollback-residual" && item.path === orphan && item.sha256 === orphanBeforeRetry)).toBe(true);
    expect((await readOwnershipLedger(home)).entries.filter((entry) => entry.path === orphan)).toEqual([]);
    expect(await readdir(join(home, ".agents/lane-pilot/coexistence/snapshots")).catch(() => [])).toEqual([]);

    const retry = await managedInstall(home, fallback);
    expect(retry.status, retry.reason ?? "").toBe("ok");
    expect(retry.path).not.toBe(orphan);
    expect(await treeHash(orphan)).toBe(orphanBeforeRetry);
    expect((await readOwnershipLedger(home)).entries.some((entry) => entry.path === retry.path && entry.snapshotId === retry.snapshotId)).toBe(true);
  }, 180_000);
});

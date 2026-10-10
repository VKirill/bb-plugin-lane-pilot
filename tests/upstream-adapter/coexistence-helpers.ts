import { afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TARGET_SHA } from "../../src/rooms/runs/constants";
import { hashPath } from "@lane-pilot/kit";
import { inventoryCoexistenceAtHome, runCoexistenceOperationAtHome } from "../../src/rooms/native-install/coexistence";


export const homes: string[] = [];
export const originalHome = process.env.HOME;
export const hostId = process.env.BB_HOST_ID ?? "host_test";

export async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "lane-pilot-coexistence-"));
  homes.push(home);
  process.env.HOME = home;
  return home;
}

export async function seedCompatibleEngine(root: string, missing: string[] = []): Promise<void> {
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

export async function makeGitRepo(root: string): Promise<void> {
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync("git", ["-C", root, "-c", "user.name=AG-251 test", "-c", "user.email=ag251@example.invalid", "add", "-A"]);
  execFileSync("git", ["-C", root, "-c", "user.name=AG-251 test", "-c", "user.email=ag251@example.invalid", "commit", "--quiet", "-m", "fixture"]);
}

export async function inventory(home: string) {
  return inventoryCoexistenceAtHome({ projectId: "proj_test", hostId, targetSha: TARGET_SHA }, home);
}

export async function treeHash(path: string): Promise<string | null> {
  try { return (await hashPath(path)).sha256; } catch { return null; }
}

/** Each test file calls this once: a worker that keeps its module cache between files would register the hook for the first file only. */
export function registerHomeCleanup() {
  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
  });
}

export const exactDd77Fixture = [
  join(process.cwd(), "../../.agency/jobs/AG-252/tmp/upstream-ref"),
  join(process.cwd(), "../upstream-ref"),
].find(existsSync);

export async function incompatibleFallback(home: string): Promise<string> {
  if (!exactDd77Fixture) throw new Error("Exact dd77 test fixture is unavailable.");
  const fallback = join(home, "dirty-source");
  execFileSync("git", ["clone", "--local", "--quiet", exactDd77Fixture, fallback]);
  const hookPath = join(fallback, "profiles/opencode/opencode-lane/index.ts");
  const hook = await readFile(hookPath, "utf8");
  await writeFile(hookPath, hook.replace('"tool.execute.after"', '"tool.execute.missing"'));
  return fallback;
}

export async function managedInstall(
  home: string,
  fallback: string,
  faultAt?: "after-rename" | "after-snapshot" | "after-ledger-commit" | "rollback-conflict",
  beforeCompensation?: (managedPath: string, snapshotFile: string) => Promise<void>,
  beforeSnapshotClaim?: (snapshotFile: string) => Promise<void>,
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
  }, home, { localFallbackPath: fallback, faultAt, beforeCompensation, beforeSnapshotClaim });
}

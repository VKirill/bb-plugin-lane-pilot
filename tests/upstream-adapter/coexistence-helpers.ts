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
  const v2 = "profiles/opencode/opencode-lane/v2.ts";
  const files: Array<[string, string, string]> = [
    ["opencode.hook.event_subscribe", v2, "ctx.event.subscribe({});"],
    ["opencode.hook.session_prompt", v2, "await ctx.session.hook(\"prompt\", async () => {});"],
    ["opencode.hook.session_context", v2, "await ctx.session.hook(\"context\", async () => {});"],
    ["opencode.hook.tool_execute_before", v2, "await ctx.tool.hook(\"execute.before\", async () => {});"],
    ["opencode.hook.tool_execute_after", v2, "await ctx.tool.hook(\"execute.after\", async () => {});"],
    ["opencode.hook.permission_evaluate", v2, "await ctx.permission.hook(\"evaluate\", async () => {});"],
    ["opencode.telemetry.session_compacted", "profiles/opencode/opencode-lane/telemetry.ts", "export function createTelemetry() { return { event: async () => { if (\"session.compacted\") return; }, after: async () => ({}) }; }\n"],
    ["opencode.sticky.contract_recovery", "profiles/opencode/opencode-lane/sticky.ts", "export function ensureStickyMessages(messages: unknown[], block: string) { if (block) messages.push(block); }\n"],
    ["opencode.sticky.dumped_tool_recovery", "profiles/opencode/opencode-lane/sticky.ts", "export function dumpedToolNote(text: string) { return text ? \"note\" : \"\"; }\n"],
    ["execution_packet.line_windows", "bin/execution_packet.py", "_WINDOW_RE = None\n"],
  ];
  const combined = new Map<string, string>();
  for (const [capability, path, content] of files) {
    if (missing.includes(capability)) continue;
    combined.set(path, `${combined.get(path) ?? ""}${combined.has(path) ? "\n" : ""}${content.trim()}`);
  }
  const hooks = combined.get(v2) ?? "";
  combined.delete(v2);
  for (const [path, content] of combined) await write(path, content);
  await write(v2, `export async function laneSetup(ctx: any) {\n${hooks}\n}\n`);
  await write("profiles/opencode/opencode-lane.ts", `export { default } from "./opencode-lane/index.ts";\n`);
  await write("profiles/opencode/opencode-lane/index.ts", missing.includes("opencode.plugin.default_export")
    ? `export default async function plugin() { return {}; }\n`
    : `import { laneSetup } from "./v2.ts";\nexport default { id: "opencode-lane", setup: laneSetup };\n`);
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

/** A Lane Stack checkout that has the managed engine's commit: the job fixture, or the sibling source repository. */
const hasTarget = (root: string): boolean => {
  try { execFileSync("git", ["-C", root, "cat-file", "-e", `${TARGET_SHA}^{commit}`], { stdio: "ignore" }); return true; } catch { return false; }
};
export const exactTargetFixture = [
  join(process.cwd(), "../../.agency/jobs/AG-252/tmp/upstream-ref"),
  join(process.cwd(), "../upstream-ref"),
  join(process.cwd(), "../claude-lane-stack"),
].find((root) => existsSync(root) && hasTarget(root));

/** A clone at the managed engine's commit whose v2 setup no longer registers tool execute.after (left uncommitted). */
export async function incompatibleFallback(home: string): Promise<string> {
  if (!exactTargetFixture) throw new Error("A Lane Stack fixture with the target commit is unavailable.");
  const fallback = join(home, "dirty-source");
  execFileSync("git", ["clone", "--local", "--quiet", exactTargetFixture, fallback]);
  execFileSync("git", ["-C", fallback, "checkout", "--quiet", "--detach", TARGET_SHA]);
  const hookPath = join(fallback, "profiles/opencode/opencode-lane/v2.ts");
  const hook = await readFile(hookPath, "utf8");
  await writeFile(hookPath, hook.replaceAll('"execute.after"', '"execute.missing"'));
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

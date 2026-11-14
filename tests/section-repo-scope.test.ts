import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import type { TaskV2 } from "../src/rooms/contracts";
import { criticLevel, planCriticTier } from "../src/rooms/critique/critic-level";
import { checkoutBase, createAttempt, createRun, createTask, openDatabase, taskBasePath } from "../src/rooms/plugin-db";
import { checkoutOwnsOverlap, leavesSection, parseRepoRoot, planWithRepoScope, rerootToRepoRoot, taskInRunScope } from "../src/rooms/tasks";
import { batchAdviceFor } from "../src/rooms/writer/server/dispatch-guards";

const R = "/srv/monorepo";
const BOT = `${R}/aiphoto_bot`;
const task = (over: Partial<TaskV2> = {}): TaskV2 => ({
  schema_version: 2, id: "t", title: "t", risk: "low", lane: "writer", project_cwd: BOT, read_first: ["README.md"], interfaces: [], invariants: [], out_of_scope: [],
  expected_outputs: ["../sdk/src/x.ts", "src/bot.ts"], owns_paths: ["../sdk/src/x.ts", "src/bot.ts"], never_touch: ["src/secret.ts"], depends_on: [], objective: "o",
  acceptance: ["a"], verify: "none", verification: [{ command: "npx tsc --noEmit", cwd: BOT }], ...over,
});

describe("the repository root of a section, as git answers on the host", () => {
  it("reads the root, the way up from the run folder and the section's place; null for the root itself, no repository or a foreign answer", () => {
    expect(parseRepoRoot({ exitCode: 0, stdout: `${R}\n${BOT}\n` })).toEqual({ up: "..", prefix: "aiphoto_bot" });
    expect(parseRepoRoot({ exitCode: 0, stdout: `${R}\n${R}/apps/bots/a\n` })).toEqual({ up: "../../..", prefix: "apps/bots/a" });
    expect(parseRepoRoot({ exitCode: 0, stdout: `${R}\n${R}\n` })).toBeNull();
    expect(parseRepoRoot({ exitCode: 128, stdout: "" })).toBeNull();
    expect(parseRepoRoot({ exitCode: 0, stdout: `/other\n${BOT}\n` })).toBeNull();
    expect(parseRepoRoot(null)).toBeNull();
  });
  it("sees which paths climb out of the section", () => {
    expect(leavesSection("../sdk/x.ts")).toBe(true);
    expect(leavesSection("./../sdk")).toBe(true);
    expect(leavesSection("src/../../sdk")).toBe(true);
    expect(leavesSection("src/../lib/x.ts")).toBe(false);
    expect(leavesSection("src/a.ts")).toBe(false);
  });
});

describe("a section's task moved to the repository root", () => {
  it("writes every path from the root, keeps the checks in the section and names what lies outside it", () => {
    const moved = rerootToRepoRoot(task(), R, "aiphoto_bot")!;
    expect(moved.task).toMatchObject({
      project_cwd: R, repo_scope: true, owns_paths: ["sdk/src/x.ts", "aiphoto_bot/src/bot.ts"], expected_outputs: ["sdk/src/x.ts", "aiphoto_bot/src/bot.ts"],
      read_first: ["aiphoto_bot/README.md"], verification: [{ command: "npx tsc --noEmit", cwd: BOT }],
    });
    expect(moved.task.never_touch).toContain("aiphoto_bot/src/secret.ts");
    // the root's own trusted tooling (hooks, CI) is protected again
    expect(moved.task.never_touch).toContain(".github/workflows/**");
    expect(moved.outside).toEqual(["sdk/src/x.ts"]);
    expect(planWithRepoScope("Do it.", R, "aiphoto_bot", moved.outside)).toContain("Outside the section you may change only: sdk/src/x.ts");
  });
  it("keeps wildcards and a trailing slash, and refuses a path that leaves the repository or a check outside it", () => {
    const moved = rerootToRepoRoot(task({ owns_paths: ["../sdk/**", "../packages/shared/", "src/**"], expected_outputs: ["src/bot.ts"] }), R, "aiphoto_bot")!;
    expect(moved.task.owns_paths).toEqual(["sdk/**", "packages/shared/", "aiphoto_bot/src/**"]);
    expect(rerootToRepoRoot(task({ owns_paths: ["../../elsewhere/x.ts"] }), R, "aiphoto_bot")).toBeNull();
    expect(rerootToRepoRoot(task({ expected_outputs: ["../../elsewhere/x.ts"] }), R, "aiphoto_bot")).toBeNull();
    expect(rerootToRepoRoot(task({ owns_paths: ["/etc/passwd"] }), R, "aiphoto_bot")).toBeNull();
    expect(rerootToRepoRoot(task({ verification: [{ command: "make", cwd: "/elsewhere" }] }), R, "aiphoto_bot")).toBeNull();
  });
});

describe("the checkout of a repo_scope task", () => {
  it("is the root above the run folder only for a flagged contract, and only an ancestor", () => {
    expect(checkoutBase(BOT, R)).toBe(BOT);
    expect(checkoutBase(BOT, R, true)).toBe(R);
    expect(checkoutBase(BOT, "/srv/other", true)).toBe(BOT);
    expect(checkoutBase(BOT, `${R}-copy`, true)).toBe(BOT);
    expect(checkoutBase(BOT, `${BOT}/src`, true)).toBe(`${BOT}/src`);
    expect(taskInRunScope(BOT, { project_cwd: R, repo_scope: true })).toBe(true);
    expect(taskInRunScope(BOT, { project_cwd: R })).toBe(false);
    expect(taskInRunScope(BOT, { project_cwd: "/srv/other", repo_scope: true })).toBe(false);
  });
});

describe("repo_scope is strict for the critics", () => {
  const green = [{ exitCode: 0 }];
  it("gates the code critic with the reason repo_scope, even for a small green fix", () => {
    expect(criticLevel({ taskId: "t1", kind: "fix", risk: "low", paths: ["sdk/src/x.ts"], checks: green })).toMatchObject({ tier: "skip" });
    expect(criticLevel({ taskId: "t1", kind: "fix", risk: "low", paths: ["sdk/src/x.ts"], checks: green, repoScope: true })).toEqual({ tier: "strict", reason: "repo_scope" });
    expect(criticLevel({ taskId: "t1", kind: "fix", risk: "low", paths: ["sdk/src/x.ts"], checks: green, repoScope: false }).tier).toBe("skip");
  });
  it("sends the plan to the strong critic with the reason repo_scope", () => {
    expect(planCriticTier({ risk: "low" }, "standard")).toEqual({ tier: "light", reason: null });
    expect(planCriticTier({ risk: "low", repo_scope: true }, "standard")).toEqual({ tier: "strong", reason: "repo_scope" });
    expect(planCriticTier({ risk: "high" }, "standard").tier).toBe("strong");
    expect(planCriticTier({ risk: "low" }, "full").tier).toBe("strong");
  });
});

describe("tasks of different sections of one repository", () => {
  const sdkTask = (id: string, run: string, owns: string[]) => ({ ...rerootToRepoRoot(task({ id, owns_paths: owns, expected_outputs: [owns[0]!] }), R, run)!.task });
  function world() {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run-bot", "proj", "bb", BOT);
    createRun(db, "run-shop", "proj", "bb", `${R}/shop_bot`);
    return db;
  }
  it("compare as one queue when they own the same SDK file, and not when they own different ones", () => {
    const a = sdkTask("a", "aiphoto_bot", ["../sdk/src/x.ts"]);
    const b = sdkTask("b", "shop_bot", ["../sdk/src/x.ts"]);
    const c = sdkTask("c", "shop_bot", ["../sdk/src/y.ts"]);
    expect(checkoutOwnsOverlap(R, a.owns_paths, R, b.owns_paths)).toBe(true);
    expect(checkoutOwnsOverlap(R, a.owns_paths, R, c.owns_paths)).toBe(false);
  });
  it("hold a repo_scope task behind another section's plain task over the same files, but not behind a sibling section's own files", () => {
    // the plain task of the shop section (checkout = shop_bot) against the root task of the bot section
    expect(checkoutOwnsOverlap(R, ["shop_bot/src/**"], `${R}/shop_bot`, ["src/a.ts"])).toBe(true);
    expect(checkoutOwnsOverlap(R, ["aiphoto_bot/src/**", "sdk/x.ts"], `${R}/shop_bot`, ["src/a.ts"])).toBe(false);
  });
  it("see each other through the stored checkouts of the project's open tasks", () => {
    const db = world();
    const a = sdkTask("a", "aiphoto_bot", ["../sdk/src/x.ts"]);
    const b = sdkTask("b", "shop_bot", ["../sdk/src/x.ts"]);
    createTask(db, { id: "a", runId: "run-bot", kind: "bb", contract: a });
    createAttempt(db, { id: "att-a", runId: "run-bot", taskId: "a" });
    expect(taskBasePath(db, "run-bot", "a")).toBe(R);
    createRun(db, "run-shop2", "proj", "bb", `${R}/shop_bot`);
    // the shop section's task is dispatched from its own run folder; its base is the root as well
    expect(checkoutBase(`${R}/shop_bot`, b.project_cwd, b.repo_scope === true)).toBe(R);
    const advice = batchAdviceFor(db, "proj", "run-shop", { ...b, depends_on: [] }).join("\n");
    expect(advice).toBeDefined();
    createTask(db, { id: "a2", runId: "run-bot", kind: "bb", contract: sdkTask("a2", "aiphoto_bot", ["../sdk/src/x.ts"]) });
    createAttempt(db, { id: "att-a2", runId: "run-bot", taskId: "a2" });
    createTask(db, { id: "a3", runId: "run-bot", kind: "bb", contract: sdkTask("a3", "aiphoto_bot", ["../sdk/src/x.ts"]) });
    createAttempt(db, { id: "att-a3", runId: "run-bot", taskId: "a3" });
    // three open tasks over one SDK file, written from two different sections, are one queue
    expect(batchAdviceFor(db, "proj", "run-shop", { ...b, depends_on: [] }).join("\n")).toMatch(/queue: b waits for 3 open tasks/);
  });
});

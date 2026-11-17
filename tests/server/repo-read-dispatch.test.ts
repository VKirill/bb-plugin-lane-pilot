// Contract normalization for a same-repo sibling read_first (repo-read dispatch path).
// A section-scoped task (project_cwd = section folder, owns_paths inside it, repo_scope unset)
// may name read_first files of a sibling section via "../sdk/x.ts:1-2". Dispatch and
// lane_pilot_update_task must persist the canonical `repo:` selector resolved against the
// repository root — never the raw "../" — while the runCommand root probe goes to the host
// with the SECTION cwd and snapshotDryRun probes the repo-root-absolute path.
// The writer is stopped by a spawn failure (owned fakehost): the contract must already be
// persisted, so a tool that refused before persistence fails these assertions.
import { coreFileWrite, diskStore } from "../helpers/core-files";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin from "../../server";
import * as handlers from "../../src/rooms/host-worker/host-handlers";
import type { TaskV2 } from "../../src/rooms/contracts";
import { countAttempts, createAttempt, createRun, getTask, setTaskHeldUntil, openDatabase, saveProjectSetting, savePrototypeConfig, setRunThread } from "../../src/rooms/plugin-db";

const projectId = "project-repo-read";
const pmThreadId = "pm-repo-read";
const runId = "run-repo-read";
const realHome = process.env.HOME;
const roots: string[] = [];
const disposers:Array<()=>Promise<unknown>>=[];

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

function put(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "lane-pilot-home-"));
  roots.push(home);
  process.env.HOME = home;
  const root = mkdtempSync(join(tmpdir(), "lane-pilot-repo-read-"));
  roots.push(root);
  put(root, "sdk/x.ts", "export const x = 1;\n");
  put(root, "sdk/y.ts", "export const y = 2;\n");
  put(root, "bot/src/main.ts", "export const main = \"old\";\n");
  put(root, "bot/README.md", "bot\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  const folder = join(root, "bot");
  const config = {
    projectId, hostId: "host-mono", pmWorkspacePath: folder, writerWorkspacePath: folder,
    pmProviderId: "claude-code", pmModel: "claude-test", writerProviderId: "codex", writerModel: "codex-test",
  };
  const hostCalls: Array<{ method: string; input: Record<string, unknown> }> = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: { threads: {
      getPluginMetadata: async ({ threadId }) => threadId === pmThreadId ? { role: "pm", lanePilotRunId: runId } : { role: "writer" },
      // Spawn-failure seam: the writer never starts; the persisted contract is what is under test.
      spawn: async () => { throw new Error("writer spawn disabled for this fixture"); },
      get: async ({ threadId }) => ({ id: threadId, status: "idle", projectId }) as never,
      output: async () => ({ text: "" }),
      list: async () => [] as never,
      context: async () => ({ usage: null }) as never,
      updatePluginMetadata: async () => ({}) as never,
      send: async () => undefined,
      events: { list: async () => [] as never },
    }, providers: {
      list: async () => [{ id: "codex", available: true, capabilities: { supportsServiceTier: true }, serviceTiers: [{ id: "default", label: "Default" }] }] as never,
      models: async () => ({ models: [{ id: "codex-test", model: "codex-test",
        supportedReasoningEfforts: ["medium", "high"].map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })) }] as never }),
    }, files: {
      read: async (args) => {
        const path = (args as { path: string }).path;
        return existsSync(path) ? { content: readFileSync(path, "utf8") } : { content: null };
      },
      listPaths: async () => ({ paths: [] }) as never,
      write: coreFileWrite(diskStore()) as never,
    }, projects: {
      get: async () => ({ id: projectId, name: projectId, sources: [{ hostId: "host-mono", path: folder }] }) as never,
      list: async () => [] as never,
    } },
    experimental_callHostRpc: async (call) => {
      const input = call.input as Record<string, unknown>;
      hostCalls.push({ method: call.method, input });
      if (call.method === "classifyPlan") {
        return { hostId: "host-mono", status: "ok", effort: "medium", reason: null, planSha256: "a", sentPlanSha256: "a", sourceLength: 1, sentLength: 1 };
      }
      if (call.method === "diskFree") return { hostId: "host-mono", status: "ok", freeBytes: 500 * 1024 ** 3, totalBytes: 1000 * 1024 ** 3 };
      if (!["runCommand","snapshotDryRun","listFolders","whichPrograms","detect","readBoundedFile"].includes(call.method)) throw new Error(`fixture refuses mutation host method ${call.method}`);
      const handler = (handlers as Record<string, unknown>)[call.method];
      if (typeof handler !== "function") throw new Error(`unexpected host call ${call.method}`);
      const result=await (handler as (input: unknown) => Promise<Record<string,unknown>>)(input);
      return { ...result, hostId:"host-mono" };
    },
  });
  const db = openDatabase(bb);
  savePrototypeConfig(db, config);
  for (const [key, value] of [["plan_critique.enabled", false], ["memory.enabled", false], ["workspace.provider", false],
    ["integration.gate", "off"], ["docs.enabled", false], ["project_life.enabled", false]] as const) saveProjectSetting(db, projectId, key, value);
  createRun(db, runId, projectId, "bb", folder, "none", {schemaVersion:1,pools:{provider:5,verification:2}}, "host-mono");
  setRunThread(db, runId, pmThreadId);
  await plugin(bb);
  disposers.push(()=>harness.lifecycle.dispose());
  const call = async (tool: string, args: Record<string, unknown>) =>
    JSON.parse(String(await harness.behavior.callAgentTool(tool, args, { threadId: pmThreadId, projectId }))) as Record<string, unknown>;
  return { db, harness, root, folder, hostCalls, call };
}

beforeEach(() => { process.env.LANE_PILOT_DISPATCH_ANSWER_MS = "5000"; });
afterEach(async () => {
  for(const dispose of disposers.splice(0)) await dispose();
  delete process.env.LANE_PILOT_DISPATCH_ANSWER_MS;
  process.env.HOME = realHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("repo: read_first normalization on dispatch and update", () => {
  it("rejects repo: write selectors before creating a task or attempt", async () => {
    const env = await setup();
    const answer = await env.call("lane_pilot_dispatch_writer", { confirm: true, objective: "Write the marker", plan: "Write the marker", task: {
      schema_version: 2, display_title: "Invalid selector", kind: "fix", area: "feature:marker", id: "invalid-selector",
      title: "Write the marker", risk: "low", lane: "writer", project_cwd: env.folder, read_first: [], interfaces: ["i"], invariants: ["inv"], out_of_scope: ["out"],
      expected_outputs: ["the marker is updated"], owns_paths: ["repo:packages/shared/marker.txt"], never_touch: [], depends_on: [],
      objective: "write marker", acceptance: ["updated"], verify: "none", verification: [{ command: "true", cwd: "repo:." }], repo_scope: true,
    }});
    expect(JSON.stringify(answer)).toContain("repo:");
    expect(getTask(env.db, "invalid-selector")).toBeUndefined();
    expect(countAttempts(env.db, runId, "invalid-selector")).toBe(0);
  });

  it("keeps an independent nested repository inside its own root", async () => {
    const env = await setup();
    git(env.folder,"init","-q","-b","main");
    git(env.folder,"add","-A");
    git(env.folder,"commit","-q","-m","nested base");
    const escaped = await env.call("lane_pilot_read", {path:"repo:../sdk/x.ts",offset:0,maxLines:10});
    expect(escaped.ok).toBe(false);
    await env.call("lane_pilot_dispatch_writer", {confirm:true,objective:"Change SDK",plan:"Change outer SDK",task:{
      schema_version:2,display_title:"Outer change",kind:"feature",area:"feature:outer",id:"outer-change",title:"Change outer",risk:"low",lane:"writer",project_cwd:env.folder,
      read_first:["README.md"],interfaces:["i"],invariants:["inv"],out_of_scope:["out"],expected_outputs:["../sdk/x.ts"],owns_paths:["../sdk/x.ts"],never_touch:[],depends_on:[],
      objective:"change outer",acceptance:["updated"],verify:"none",verification:[{command:"true",cwd:env.folder,timeout_sec:60}],
    }});
    expect(getTask(env.db,"outer-change")).toBeUndefined();
  });
  it("reads a sibling through the registered PM tool and places declared edits at the shared root", async () => {
    const env = await setup();
    const read = await env.call("lane_pilot_read", {path:"repo:sdk/x.ts",offset:0,maxLines:10});
    expect(read, JSON.stringify(read)).toMatchObject({content:expect.stringContaining("export const x")});
    await env.call("lane_pilot_dispatch_writer", { confirm:true, objective:"Change bot and SDK", plan:"Change bot/src/main.ts and sdk/x.ts", task:{
      schema_version:2, display_title:"Shared change", kind:"feature", area:"feature:shared", id:"shared-change",
      title:"Change bot and SDK", risk:"low", lane:"writer", project_cwd:env.folder,
      read_first:["../sdk/x.ts", "src/main.ts"], interfaces:["i"], invariants:["inv"], out_of_scope:["out"],
      expected_outputs:["src/main.ts", "../sdk/x.ts"], owns_paths:["src/main.ts", "../sdk/x.ts"], never_touch:[], depends_on:[],
      objective:"change both files", acceptance:["both updated"], verify:"none",
      verification:[{command:"test -f src/main.ts",cwd:env.folder,timeout_sec:60}],
    }});
    const stored = getTask(env.db,"shared-change")?.contract as TaskV2 | undefined;
    expect(stored,"dispatch refused before persisting").toBeDefined();
    expect(stored).toMatchObject({project_cwd:env.root,repo_scope:true,owns_paths:["bot/src/main.ts","sdk/x.ts"],read_first:["sdk/x.ts","bot/src/main.ts"]});
    expect(stored!.verification[0]!.cwd).toBe(env.folder);
    createAttempt(env.db,{id:"held-root-attempt",runId,taskId:"shared-change"});
    setTaskHeldUntil(env.db,"shared-change",runId,Date.now()+86_400_000);
    git(env.folder,"init","-q","-b","main");
    const stale = await env.call("lane_pilot_update_task", {taskId:"shared-change",task:stored});
    expect(stale).toMatchObject({ok:false,error:{code:"validation_failed"}});
  });

  it("accepts a root-relative contract explicitly naming the shared repository", async () => {
    const env=await setup();
    await env.call("lane_pilot_dispatch_writer", {confirm:true,objective:"Change both",plan:"Change bot and SDK",task:{
      schema_version:2,display_title:"Root change",kind:"feature",area:"feature:root",id:"root-change",title:"Change both",risk:"low",lane:"writer",project_cwd:env.root,
      read_first:["repo:sdk/x.ts","bot/src/main.ts"],interfaces:["i"],invariants:["inv"],out_of_scope:["out"],expected_outputs:["bot/src/main.ts","sdk/x.ts"],owns_paths:["bot/src/main.ts","sdk/x.ts"],never_touch:[],depends_on:[],
      objective:"change both",acceptance:["updated"],verify:"none",verification:[{command:"test -f src/main.ts",cwd:env.folder,timeout_sec:60}],
    }});
    const stored=getTask(env.db,"root-change")?.contract as TaskV2|undefined;
    expect(stored,"explicit root dispatch refused").toMatchObject({project_cwd:env.root,repo_scope:true,owns_paths:["bot/src/main.ts","sdk/x.ts"]});
  });

  it("persists the section contract with canonical repo: read_first, probed on the host at the section cwd", async () => {
    const env = await setup();
    await env.call("lane_pilot_dispatch_writer", { confirm: true, objective: "Read the SDK", plan: "Read sdk/x.ts", task: {
      schema_version: 2, display_title: "Repo read dispatch", kind: "feature", area: "feature:bot-lib", id: "bot-lib",
      title: "Read a sibling SDK file", risk: "low", lane: "writer", project_cwd: env.folder,
      read_first: ["../sdk/x.ts:1-2", "README.md"], interfaces: ["i"], invariants: ["inv"], out_of_scope: ["out"],
      expected_outputs: ["src/main.ts"], owns_paths: ["src/main.ts"], never_touch: [], depends_on: [],
      objective: "read the sdk file", acceptance: ["main updated"], verify: "none",
      verification: [{ command: "test -f src/main.ts", cwd: env.folder, timeout_sec: 60 }],
    } });
    // The tool must have persisted the contract — every later assertion is meaningless if it refused first.
    const stored = getTask(env.db, "bot-lib")?.contract as TaskV2 | undefined;
    expect(stored, "dispatch refused before persisting the task").toBeDefined();
    expect(stored!.project_cwd).toBe(env.folder);
    expect(stored!.repo_scope).toBeUndefined();
    expect(stored!.owns_paths).toEqual(["src/main.ts"]);
    expect(stored!.read_first).toContain("repo:sdk/x.ts:1-2");
    expect(stored!.read_first!.some((path) => path.includes(".."))).toBe(false);
    // The root probe ran on the host with the section cwd, not the repo root or the hub.
    const probe = env.hostCalls.find((call) => call.method === "runCommand" && String(call.input.command).includes("--show-toplevel"));
    expect(probe, "no runCommand root probe recorded").toBeDefined();
    expect(probe!.input.requestedHostId).toBe("host-mono");
    expect(probe!.input.cwd).toBe(env.folder);
    // snapshotDryRun probed the repo-root-absolute path of the sibling file.
    const snap = env.hostCalls.find((call) => call.method === "snapshotDryRun");
    expect(snap, "no snapshotDryRun probe recorded").toBeDefined();
    const probePaths = (snap!.input.paths as string[]).map(String);
    expect(probePaths.some((path) => path === join(env.root, "sdk", "x.ts"))).toBe(true);
  });

  it("lane_pilot_update_task re-normalizes a sibling read_first to the canonical repo: path", async () => {
    const env = await setup();
    await env.call("lane_pilot_dispatch_writer", { confirm: true, objective: "Read the SDK", plan: "Read sdk/x.ts", task: {
      schema_version: 2, display_title: "Repo read dispatch", kind: "feature", area: "feature:bot-lib", id: "bot-lib",
      title: "Read a sibling SDK file", risk: "low", lane: "writer", project_cwd: env.folder,
      read_first: ["../sdk/x.ts:1-2", "README.md"], interfaces: ["i"], invariants: ["inv"], out_of_scope: ["out"],
      expected_outputs: ["src/main.ts"], owns_paths: ["src/main.ts"], never_touch: [], depends_on: [],
      objective: "read the sdk file", acceptance: ["main updated"], verify: "none",
      verification: [{ command: "test -f src/main.ts", cwd: env.folder, timeout_sec: 60 }],
    } });
    expect(getTask(env.db, "bot-lib"), "dispatch refused before persisting the task").toBeDefined();
    // Dispatch persisted the contract, but the fixture stop is not an updatable runtime state.
    // Seed a held queued attempt to exercise the registered update contract independently of execution.
    createAttempt(env.db,{id:"held-update-attempt",runId,taskId:"bot-lib"});
    setTaskHeldUntil(env.db,"bot-lib",runId,Date.now()+86_400_000);
    const updated = await env.call("lane_pilot_update_task", { taskId: "bot-lib", task: { ...(getTask(env.db,"bot-lib")!.contract as TaskV2), read_first: ["../sdk/y.ts:1-1", "README.md"] } });
    const stored = getTask(env.db, "bot-lib")?.contract as TaskV2 | undefined;
    expect(stored, `update_task refused or task lost: ${JSON.stringify(updated)}`).toBeDefined();
    expect(updated, JSON.stringify(updated)).toMatchObject({ok:true});
    expect(stored!.read_first, JSON.stringify(updated)).toContain("repo:sdk/y.ts:1-1");
    expect(stored!.read_first!.some((path) => path.includes(".."))).toBe(false);
    expect(stored!.project_cwd).toBe(env.folder);
    expect(stored!.repo_scope).toBeUndefined();
  });
});

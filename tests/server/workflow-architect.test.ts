import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../../server";
import { writeWorkflowFile } from "../../src/host-handlers";
import { REALTIME_WINDOW_MS } from "../../src/server/realtime";
import { globalWorkflowDir, loadWorkflowStore, projectWorkflowDir } from "../../src/workflow/store";
import { BROWSER_DIGEST_STEPS } from "../workflow/architect-fixture";

const projectId = "proj_arch";
const threadId = "thr_arch";
const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "lp-arch-")); dirs.push(dir); return dir; };
let dispose: (() => Promise<void> | void) | null = null;

beforeEach(() => { vi.stubEnv("HOME", temp()); });
afterEach(async () => { await dispose?.(); dispose = null; vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function setup(options: { project?: string; secrets?: boolean } = {}) {
  const project = options.project ?? temp();
  const hostCalls: string[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    experimental_callHostRpc: (async (call: { method: string; input: Record<string, unknown> }) => {
      hostCalls.push(call.method);
      if (call.method === "writeWorkflowFile") return writeWorkflowFile(call.input as never, undefined as never);
      if (call.method === "session_inventory") return { mcpServers: [{ name: "metamcp", sources: ["claude"] }, { name: "tavily", sources: ["claude", "codex"] }], nativePlugins: [] };
      throw new Error(`unexpected host call ${call.method}`);
    }) as never,
    sdk: {
      threads: { get: async ({ threadId: id }: { threadId: string }) => ({ id, status: "idle", projectId, environmentId: "env_arch" }) },
      environments: { get: async () => ({ id: "env_arch", hostId: "host_arch", path: project, status: "ready" }) },
      skills: { list: async () => ({ skills: [{ name: "browser-automation", description: "Drive a persistent browser", pluginId: "browser-automation" }, { name: "telegram-user", description: "Use the owner's Telegram" }, { name: "ru-text", description: "Russian typography" }] }) },
      plugins: {
        list: async () => [{ id: "browser-automation", name: "Browser Automation" }, { id: "env-catalog", name: "Env Catalog" }],
        callRpc: async ({ method }: { method: string }) => {
          if (method === "env_list") {
            if (options.secrets === false) throw new Error("env-catalog is not installed");
            return { variables: [{ name: "TELEGRAM_SESSION", kind: "secret" }, { name: "X_LOGIN", kind: "login" }] };
          }
          throw new Error(`unexpected rpc ${method}`);
        },
      },
      hosts: { list: async () => [{ id: "host_arch", name: "MacBook", status: "online" }, { id: "mini", name: "Mac mini", status: "online" }] },
    } as never,
  });
  await plugin(bb);
  dispose = () => harness.lifecycle.dispose();
  const call = async (name: string, params: Record<string, unknown>) =>
    JSON.parse(String(await harness.behavior.callAgentTool(name, params, { threadId, projectId }))) as Record<string, any>;
  const rpc = async (name: string, params: Record<string, unknown>) => await harness.behavior.callRpc(name, params) as Record<string, any>;
  return { project, harness, call, rpc, hostCalls };
}

async function build(call: Awaited<ReturnType<typeof setup>>["call"], scope: "global" | "project" = "global") {
  const created = await call("lane_pilot_workflow_draft_create", { name: "Browser digest", description: "Search the web, analyse documents, summarise, send to Telegram", scope });
  const draftId = created.draftId as string;
  const patches = [];
  for (const ops of BROWSER_DIGEST_STEPS) patches.push(await call("lane_pilot_workflow_draft_patch", { draftId, ops }));
  return { created, draftId, patches };
}

describe("workflow architect tools", () => {
  it("builds «browser search, document analysis, summary, Telegram» by patches, tests it on stubs and publishes it", async () => {
    const { call, harness, rpc } = await setup();
    const { created, draftId, patches } = await build(call);
    expect(created).toMatchObject({ workflowId: "browser-digest", version: 1, status: "draft" });
    // The frame alone is unfinished: problems come back with the next step, and it is saved all the same.
    expect(patches[0]).toMatchObject({ ok: true, applied: true, valid: false, version: 2 });
    expect(patches[0]!.problems.some((problem: { level: string }) => problem.level === "error")).toBe(true);
    expect(patches[0]!.next).toContain("lane_pilot_workflow_draft_patch");
    const last = patches.at(-1)!;
    expect(last).toMatchObject({ valid: true, errors: 0, nodes: 7, version: 1 + BROWSER_DIGEST_STEPS.length });
    expect(last.next).toContain("lane_pilot_workflow_draft_test");

    const tested = await call("lane_pilot_workflow_draft_test", { draftId });
    expect(tested).toMatchObject({ ran: true, green: true, status: "tested", allCasesRun: true });
    expect(tested.cases.map((row: { caseId: string }) => row.caseId)).toEqual(["digest", "digest/blocked", "digest/declined"]);
    expect(tested.cases[0].stubbedCalls).toEqual(expect.arrayContaining(["send (action: telegram.send_rich)", "search (agent)"]));
    expect(tested.next).toContain("lane_pilot_workflow_draft_publish");

    const published = await call("lane_pilot_workflow_draft_publish", { draftId, confirm: true });
    expect(published).toMatchObject({ published: true, workflowId: "browser-digest", scope: "global", workflowVersion: 1 });
    expect(published.unregisteredExecutors).toEqual(["agent", "telegram.send_rich"]);
    const file = join(globalWorkflowDir(), "browser-digest.json");
    expect(existsSync(file)).toBe(true);
    // The published file is a workflow the store loads, with the status the publish gave it.
    const store = await loadWorkflowStore({ builtin: [], globalDir: globalWorkflowDir() });
    expect(store.problems).toEqual([]);
    expect(store.get("browser-digest")).toMatchObject({ origin: "global", workflow: { status: "published", version: 1, scope: { level: "global" } } });

    // The screen reads the same through the RPCs.
    const listed = await rpc("workflow_draft_list", { projectId });
    expect(listed.drafts).toMatchObject([{ id: draftId, status: "published", tested: "green", nodes: 7, errors: 0, publishedPath: file }]);
    const read = await rpc("workflow_draft_get", { draftId, history: true });
    expect(read.draft.version).toBe(1 + BROWSER_DIGEST_STEPS.length);
    expect(read.check).toMatchObject({ valid: true });
    expect(read.definition).toMatchObject({ id: "browser-digest", nodes: expect.any(Array) });
    expect(read.history).toHaveLength(1 + BROWSER_DIGEST_STEPS.length);
    expect((await rpc("workflow_draft_get", { draftId: "wfd_nope" })).draft).toBeNull();
    expect(harness.registrations.agentTools.filter((tool) => tool.name.startsWith("lane_pilot_workflow_")).map((tool) => tool.name).sort()).toEqual([
      "lane_pilot_workflow_capabilities", "lane_pilot_workflow_draft_create", "lane_pilot_workflow_draft_get", "lane_pilot_workflow_draft_patch", "lane_pilot_workflow_draft_publish", "lane_pilot_workflow_draft_test",
    ]);
  });

  it("publishes a project draft through the project's machine into its own .lane-pilot/workflows", async () => {
    const { call, hostCalls, project } = await setup();
    const { draftId } = await build(call, "project");
    expect((await call("lane_pilot_workflow_draft_test", { draftId })).green).toBe(true);
    const published = await call("lane_pilot_workflow_draft_publish", { draftId, confirm: true });
    expect(published).toMatchObject({ published: true, scope: "project", path: ".lane-pilot/workflows/browser-digest.json" });
    expect(hostCalls).toContain("writeWorkflowFile");
    const store = await loadWorkflowStore({ builtin: [], projectDir: projectWorkflowDir(project) });
    expect(store.get("browser-digest")).toMatchObject({ origin: "project", workflow: { scope: { level: "project", projectId } } });
    // Publishing again after a change is a new version over the file this draft wrote.
    await call("lane_pilot_workflow_draft_patch", { draftId, ops: [{ op: "update_node", id: "send", set: { maxAttempts: 2 } }] });
    expect((await call("lane_pilot_workflow_draft_publish", { draftId, confirm: true })).reason).toBe("tests_stale");
    expect((await call("lane_pilot_workflow_draft_test", { draftId })).green).toBe(true);
    expect(await call("lane_pilot_workflow_draft_publish", { draftId, confirm: true })).toMatchObject({ published: true, workflowVersion: 2 });
  });

  it("refuses to publish with red, missing or stale tests, and never overwrites a file it did not write", async () => {
    const { call } = await setup();
    const { draftId } = await build(call);
    expect(await call("lane_pilot_workflow_draft_publish", { draftId, confirm: true })).toMatchObject({ published: false, reason: "no_tests" });

    // A case that expects a path the graph does not take is red.
    await call("lane_pilot_workflow_draft_patch", { draftId, ops: [{ op: "set_meta", set: { test: { id: "wrong", sim: {
      input: { query: "q", chat: "me" }, stubs: { search: { status: "done" } }, human_answers: { approve: "send" }, expect_path: ["search", "sent"] } } } }] });
    const red = await call("lane_pilot_workflow_draft_test", { draftId });
    expect(red).toMatchObject({ green: false, status: "draft" });
    expect(red.cases[0].failures[0]).toContain("is not the expected");
    expect(red.next).toContain("fix");
    const refused = await call("lane_pilot_workflow_draft_publish", { draftId, confirm: true });
    expect(refused).toMatchObject({ published: false, reason: "tests_not_green" });
    expect(refused.failing[0].caseId).toBe("wrong");
    expect(existsSync(join(globalWorkflowDir(), "browser-digest.json"))).toBe(false);
    await expect(call("lane_pilot_workflow_draft_publish", { draftId, confirm: false })).rejects.toThrow(/arguments are invalid/);

    // Fixed, green, but someone else already has a file with this id.
    await call("lane_pilot_workflow_draft_patch", { draftId, ops: [{ op: "set_meta", set: { test: { id: "ok", sim: { input: { query: "q", chat: "me" }, stubs: { search: { status: "done" } }, human_answers: { approve: "send" }, expect_path: ["search", "analyze", "summarize", "approve", "send", "sent"] } } } }] });
    expect((await call("lane_pilot_workflow_draft_test", { draftId })).green).toBe(true);
    mkdirSync(globalWorkflowDir(), { recursive: true });
    writeFileSync(join(globalWorkflowDir(), "browser-digest.json"), "{\"mine\": true}");
    const clash = await call("lane_pilot_workflow_draft_publish", { draftId, confirm: true });
    expect(clash).toMatchObject({ published: false, reason: "file_conflict" });
    expect(readFileSync(join(globalWorkflowDir(), "browser-digest.json"), "utf8")).toBe("{\"mine\": true}");
    // Another id publishes.
    await call("lane_pilot_workflow_draft_patch", { draftId, ops: [{ op: "set_meta", set: { id: "browser-digest-2" } }] });
    expect((await call("lane_pilot_workflow_draft_test", { draftId })).green).toBe(true);
    expect(await call("lane_pilot_workflow_draft_publish", { draftId, confirm: true })).toMatchObject({ published: true, workflowId: "browser-digest-2" });
    // A built-in id is reserved.
    expect(await call("lane_pilot_workflow_draft_create", { name: "x", description: "y", workflowId: "analyze-plan-execute" })).toMatchObject({ ok: false, error: { code: "id_reserved" } });
  });

  it("surfaces refused operations and version conflicts without changing the draft", async () => {
    const { call } = await setup();
    const created = await call("lane_pilot_workflow_draft_create", { name: "Small", description: "A small chain" });
    const draftId = created.draftId as string;
    const refused = await call("lane_pilot_workflow_draft_patch", { draftId, ops: [{ op: "add_edge", edge: { from: "start", to: "ghost" } }] });
    expect(refused).toMatchObject({ ok: false, applied: false, refused: [{ index: 0, op: "add_edge" }] });
    expect(await call("lane_pilot_workflow_draft_patch", { draftId, expectedVersion: 7, ops: [{ op: "set_meta", set: { tags: ["x"] } }] })).toMatchObject({ ok: false, reason: "version_conflict", currentVersion: 1 });
    expect(await call("lane_pilot_workflow_draft_patch", { draftId: "wfd_nope", ops: [{ op: "set_meta", set: { tags: ["x"] } }] })).toMatchObject({ ok: false, error: { code: "not_found" } });
    await expect(call("lane_pilot_workflow_draft_patch", { draftId, ops: [{ op: "teleport" }] })).rejects.toThrow(/arguments are invalid/);
    const read = await call("lane_pilot_workflow_draft_get", { draftId });
    expect(read.draft.version).toBe(1);
    const all = await call("lane_pilot_workflow_draft_get", {});
    expect(all.drafts).toMatchObject([{ id: draftId, name: { en: "Small" } }]);
  });

  it("publishes one realtime signal per patch on lp:<project> with the draft id, coalescing a burst", async () => {
    const { call, harness } = await setup();
    const created = await call("lane_pilot_workflow_draft_create", { name: "Live", description: "Live graph" });
    const draftId = created.draftId as string;
    const settle = () => new Promise((resolve) => setTimeout(resolve, REALTIME_WINDOW_MS + 120));
    await settle();
    harness.realtimeSignals.length = 0;
    for (const ops of BROWSER_DIGEST_STEPS.slice(0, 3)) { await call("lane_pilot_workflow_draft_patch", { draftId, ops }); await settle(); }
    const mine = harness.realtimeSignals.filter((row) => row.channel === `lp:${projectId}` && (row.payload as { kind?: string }).kind === "workflow-draft");
    expect(mine.map((row) => row.payload)).toEqual([{ kind: "workflow-draft", threadId, draftId }, { kind: "workflow-draft", threadId, draftId }, { kind: "workflow-draft", threadId, draftId }]);
    // A burst of patches inside one window reaches the screen as one signal.
    harness.realtimeSignals.length = 0;
    await call("lane_pilot_workflow_draft_patch", { draftId, ops: [{ op: "set_meta", set: { tags: ["a"] } }] });
    await call("lane_pilot_workflow_draft_patch", { draftId, ops: [{ op: "set_meta", set: { tags: ["b"] } }] });
    await settle();
    expect(harness.realtimeSignals.filter((row) => (row.payload as { kind?: string }).kind === "workflow-draft")).toHaveLength(1);
    // A refused patch changes nothing and signals nothing.
    harness.realtimeSignals.length = 0;
    await call("lane_pilot_workflow_draft_patch", { draftId, ops: [{ op: "remove_node", id: "ghost" }] });
    await settle();
    expect(harness.realtimeSignals.filter((row) => (row.payload as { kind?: string }).kind === "workflow-draft")).toHaveLength(0);
  });

  it("lists what a chain can use from the machine: skills, plugins, MCP, secret names, machines, the browser", async () => {
    const { call } = await setup();
    const all = await call("lane_pilot_workflow_capabilities", { sections: ["skills", "plugins", "mcpServers", "secrets", "hosts", "browser", "specialists"] });
    expect(all.skills).toMatchObject({ status: "ready", items: expect.arrayContaining([{ name: "browser-automation", description: "Drive a persistent browser", plugin: "browser-automation" }]) });
    expect(all.plugins.items.map((row: { id: string }) => row.id)).toEqual(["browser-automation", "env-catalog"]);
    expect(all.mcpServers.error).toBeUndefined();
    expect(all.mcpServers.items.map((row: { name: string }) => row.name)).toEqual(["metamcp", "tavily"]);
    expect(all.secrets.items).toEqual([{ name: "TELEGRAM_SESSION", kind: "secret" }, { name: "X_LOGIN", kind: "login" }]);
    expect(JSON.stringify(all.secrets.items)).not.toMatch(/value/);
    expect(all.hosts.items.map((row: { id: string }) => row.id)).toEqual(["host_arch", "mini"]);
    expect(all.browser).toMatchObject({ browserAutomationPlugin: true, skills: { "browser-automation": true, "computer-use": false }, browserMachine: null });
    expect(all.specialists.roles).toEqual(["design-lead", "copy-lead", "seo-specialist", "tavily"]);
    const filtered = await call("lane_pilot_workflow_capabilities", { sections: ["skills"], query: "telegram" });
    expect(filtered.skills.items.map((row: { name: string }) => row.name)).toEqual(["telegram-user"]);
    expect(filtered.plugins).toBeUndefined();
    const reference = await call("lane_pilot_workflow_capabilities", { sections: ["reference"] });
    expect(Object.keys(reference.reference.nodeTypes)).toEqual(expect.arrayContaining(["agent", "lp-task", "action", "human", "parallel"]));
    expect(Object.keys(reference.reference.passModes)).toEqual(["artifact", "same-session", "read-prior-session", "fork"]);
  });

  it("says a source could not be read instead of listing it empty", async () => {
    const { call } = await setup({ secrets: false });
    const result = await call("lane_pilot_workflow_capabilities", { sections: ["secrets"] });
    expect(result.secrets).toMatchObject({ status: "unavailable", items: [] });
  });
});

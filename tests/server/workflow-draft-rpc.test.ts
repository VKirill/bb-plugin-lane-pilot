import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../../server";
import { globalWorkflowDir } from "../../src/workflow/store";
import { BROWSER_DIGEST_STEPS } from "../workflow/architect-fixture";

/** The editor's RPCs: the same drafts, validator, tests and publish as the architect's tools, called without a chat. */
const projectId = "proj_edit";
const threadId = "thr_edit";
const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "lp-edit-")); dirs.push(dir); return dir; };
let dispose: (() => Promise<void> | void) | null = null;

beforeEach(() => { vi.stubEnv("HOME", temp()); });
afterEach(async () => { await dispose?.(); dispose = null; vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function setup() {
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    experimental_callHostRpc: (async (call: { method: string }) => {
      if (call.method === "session_inventory") return { mcpServers: [{ name: "tavily", sources: ["claude"] }], nativePlugins: [] };
      throw new Error(`unexpected host call ${call.method}`);
    }) as never,
    sdk: {
      threads: { get: async ({ threadId: id }: { threadId: string }) => ({ id, status: "idle", projectId, environmentId: "env_edit" }) },
      environments: { get: async () => ({ id: "env_edit", hostId: "host_edit", path: temp(), status: "ready" }) },
      skills: { list: async () => ({ skills: [{ name: "browser-automation", description: "Drive a persistent browser", pluginId: "browser-automation" }] }) },
      plugins: {
        list: async () => [{ id: "browser-automation", name: "Browser Automation" }],
        callRpc: async ({ method }: { method: string }) => {
          if (method === "env_list") return { variables: [{ name: "TELEGRAM_SESSION", kind: "secret" }] };
          throw new Error(`unexpected rpc ${method}`);
        },
      },
      hosts: { list: async () => [{ id: "host_edit", name: "MacBook", status: "online" }] },
    } as never,
  });
  await plugin(bb);
  dispose = () => harness.lifecycle.dispose();
  const call = async (name: string, params: Record<string, unknown>) =>
    JSON.parse(String(await harness.behavior.callAgentTool(name, params, { threadId, projectId }))) as Record<string, any>;
  const rpc = async (name: string, params: Record<string, unknown>) => await harness.behavior.callRpc(name, params) as Record<string, any>;
  return { harness, call, rpc };
}

/** A finished, valid draft made by the architect's tools. */
async function finished(call: Awaited<ReturnType<typeof setup>>["call"]) {
  const created = await call("lane_pilot_workflow_draft_create", { name: "Browser digest", description: "Search the web, summarise, send to Telegram", scope: "global" });
  for (const ops of BROWSER_DIGEST_STEPS) await call("lane_pilot_workflow_draft_patch", { draftId: created.draftId, ops });
  return created.draftId as string;
}

describe("workflow_draft_patch", () => {
  it("applies operations as one version and answers with the validator's problems", async () => {
    const { rpc, call } = await setup();
    const created = await call("lane_pilot_workflow_draft_create", { name: "Mine", description: "A new one", scope: "global" });
    const draftId = created.draftId as string;

    const first = await rpc("workflow_draft_patch", { draftId, expectedVersion: 1, ops: [
      { op: "add_node", node: { id: "a", type: "agent", prompt: "x", out: [{ name: "n", type: "number" }] } },
      { op: "add_node", node: { id: "b", type: "action", action: "noop" } },
      { op: "add_edge", edge: { from: "start", to: "a" } },
      { op: "add_edge", edge: { from: "a", to: "b", when: { field: "missing", op: "eq", value: 1 } } },
      { op: "add_edge", edge: { from: "b", to: "end" } },
    ] });
    expect(first).toMatchObject({ ok: true, applied: true, version: 2, valid: false });
    // The problem carries the index of the edge, so the screen can mark it.
    expect(first.problems.find((problem: { code: string }) => problem.code === "condition_field")).toMatchObject({ level: "error", edge: 1 });
    expect(first.definition.nodes).toHaveLength(2);

    // A stale version is a conflict, not a silent overwrite of the architect's change.
    expect(await rpc("workflow_draft_patch", { draftId, expectedVersion: 1, ops: [{ op: "remove_edge", edge: { index: 1 } }] })).toMatchObject({ ok: false, applied: false, reason: "version_conflict", currentVersion: 2 });
    // An operation that cannot be applied changes nothing and says why; a malformed one is refused with its position.
    expect(await rpc("workflow_draft_patch", { draftId, ops: [{ op: "update_node", id: "ghost", set: {} }] })).toMatchObject({ ok: false, refused: [{ index: 0, reason: expect.stringContaining("ghost") }] });
    expect(await rpc("workflow_draft_patch", { draftId, ops: [{ op: "nonsense" }] })).toMatchObject({ ok: false, applied: false, refused: [{ index: 0 }] });
    expect((await rpc("workflow_draft_get", { draftId })).draft.version).toBe(2);
    await expect(rpc("workflow_draft_patch", { draftId: "wfd_nope", ops: [{ op: "set_meta", set: {} }] })).rejects.toThrow();
  });

  it("restores an earlier version as a new one (undo and redo), and refuses a stale or unknown one", async () => {
    const { rpc, call } = await setup();
    const draftId = await finished(call);
    const head = (await rpc("workflow_draft_get", { draftId })).draft.version as number;
    await rpc("workflow_draft_patch", { draftId, ops: [{ op: "remove_node", id: "send" }] });
    const broken = await rpc("workflow_draft_get", { draftId });
    expect(broken.draft.version).toBe(head + 1);
    expect(broken.check.valid).toBe(false);

    const undone = await rpc("workflow_draft_restore", { draftId, version: head, expectedVersion: head + 1 });
    expect(undone).toMatchObject({ ok: true, version: head + 2 });
    expect(undone.definition.nodes.some((node: { id: string }) => node.id === "send")).toBe(true);
    expect((await rpc("workflow_draft_get", { draftId })).check.valid).toBe(true);
    // Redo is a restore of the version the undo left.
    expect(await rpc("workflow_draft_restore", { draftId, version: head + 1 })).toMatchObject({ ok: true, version: head + 3 });
    expect((await rpc("workflow_draft_get", { draftId })).check.valid).toBe(false);
    expect(await rpc("workflow_draft_restore", { draftId, version: head, expectedVersion: 1 })).toMatchObject({ ok: false, reason: "version_conflict" });
    expect(await rpc("workflow_draft_restore", { draftId, version: 999 })).toMatchObject({ ok: false, reason: "no_such_version" });
  });
});

describe("workflow_draft_test and workflow_draft_publish", () => {
  it("tests per case on stubs, publishes only on green, and a change takes the tests back", async () => {
    const { rpc, call } = await setup();
    const draftId = await finished(call);
    expect(await rpc("workflow_draft_publish", { draftId })).toMatchObject({ published: false, reason: "no_tests" });
    const tested = await rpc("workflow_draft_test", { draftId });
    expect(tested).toMatchObject({ ran: true, green: true, allCasesRun: true });
    expect(tested.cases.map((row: { caseId: string }) => row.caseId)).toEqual(["digest", "digest/blocked", "digest/declined"]);
    expect((await rpc("workflow_draft_get", { draftId })).tests).toMatchObject({ green: true, results: expect.any(Array) });

    await rpc("workflow_draft_patch", { draftId, ops: [{ op: "update_node", id: "send", set: { maxAttempts: 2 } }] });
    expect(await rpc("workflow_draft_publish", { draftId })).toMatchObject({ published: false, reason: "tests_stale" });
    expect((await rpc("workflow_draft_test", { draftId })).green).toBe(true);
    const published = await rpc("workflow_draft_publish", { draftId });
    expect(published).toMatchObject({ published: true, workflowId: "browser-digest", scope: "global" });
    expect(existsSync(join(globalWorkflowDir(), "browser-digest.json"))).toBe(true);
    // The publish leaves the receipt of its green tests, so the library counts the file as published; the file edited by hand does not.
    const library = async () => (await rpc("workflow_list", {})).workflows.find((row: { id: string }) => row.id === "browser-digest");
    expect(await library()).toMatchObject({ status: "published" });
    const file = join(globalWorkflowDir(), "browser-digest.json");
    writeFileSync(file, readFileSync(file, "utf8").replace('"version": 1', '"version": 1, "tags": ["edited"]'));
    expect(await library()).toMatchObject({ status: "draft" });
    expect(await rpc("workflow_run_tests", { id: "browser-digest" })).toMatchObject({ found: true, green: true, status: "published" });
    expect(await library()).toMatchObject({ status: "published" });
    expect(await rpc("workflow_dry_run", { id: "browser-digest", input: {} })).toMatchObject({ found: true, result: { status: "succeeded" } });
    expect(await rpc("workflow_runs", { id: "browser-digest" })).toEqual({ runs: [], hasMore: false });
  });

  it("publishes a chain whose steps name plugins and MCP servers the machine lacks, and says which", async () => {
    const { rpc, call } = await setup();
    const draftId = await finished(call);
    await rpc("workflow_draft_patch", { draftId, ops: [{ op: "update_node", id: "search", set: { plugins: ["browser-automation", "ghost-plugin"], mcp: ["tavily", "ghost-mcp"] } }] });
    expect((await rpc("workflow_draft_test", { draftId })).green).toBe(true);
    const published = await rpc("workflow_draft_publish", { draftId });
    expect(published.published).toBe(true);
    expect(published.capabilityWarnings).toEqual(expect.arrayContaining([expect.stringContaining("BB plugin \"ghost-plugin\""), expect.stringContaining("MCP server \"ghost-mcp\"")]));
    // What the machine does list is not reported.
    expect(published.capabilityWarnings.join(" ")).not.toContain("\"tavily\"");
    expect(published.capabilityWarnings.join(" ")).not.toContain("\"browser-automation\"");
    const stored = await rpc("workflow_draft_get", { draftId });
    expect((stored.definition.nodes as Array<{ id: string; plugins?: string[] }>).find((node) => node.id === "search")!.plugins).toEqual(["browser-automation", "ghost-plugin"]);
  });

  it("reports an invalid draft instead of running it", async () => {
    const { rpc, call } = await setup();
    const created = await call("lane_pilot_workflow_draft_create", { name: "Empty", description: "Nothing yet", scope: "global" });
    expect(await rpc("workflow_draft_test", { draftId: created.draftId })).toMatchObject({ ran: false, green: false, reason: "invalid", problems: expect.any(Array) });
  });
});

describe("workflow_draft_create", () => {
  it("duplicates a built-in workflow under a new id and refuses to edit it in place", async () => {
    const { rpc } = await setup();
    const copy = await rpc("workflow_draft_create", { projectId, workflowId: "analyze-plan-execute", mode: "duplicate" });
    expect(copy).toMatchObject({ workflowId: "analyze-plan-execute-copy", reused: false });
    const read = await rpc("workflow_draft_get", { draftId: copy.draftId });
    expect(read.draft).toMatchObject({ workflowId: "analyze-plan-execute-copy", status: "draft", scope: "global", version: 1 });
    expect(read.definition).toMatchObject({ id: "analyze-plan-execute-copy", status: "draft", version: 1 });
    expect(read.check.nodes).toBeGreaterThan(5);
    // The second copy does not collide with the first.
    expect(await rpc("workflow_draft_create", { projectId, workflowId: "analyze-plan-execute", mode: "duplicate" })).toMatchObject({ workflowId: "analyze-plan-execute-copy-2" });
    expect(await rpc("workflow_draft_create", { projectId, workflowId: "analyze-plan-execute", mode: "edit" })).toMatchObject({ draftId: null, reason: "builtin_read_only" });
    expect(await rpc("workflow_draft_create", { projectId, workflowId: "no-such", mode: "edit" })).toMatchObject({ draftId: null, reason: "not_found" });
  });

  it("edits the owner's own file: a draft of it, replacing that file (and only it) when published", async () => {
    const { rpc, call } = await setup();
    // Publish one through the architect so there is a real file of the owner's.
    const first = await finished(call);
    expect((await rpc("workflow_draft_test", { draftId: first })).green).toBe(true);
    await rpc("workflow_draft_publish", { draftId: first });
    const file = join(globalWorkflowDir(), "browser-digest.json");
    const before = readFileSync(file, "utf8");

    const edit = await rpc("workflow_draft_create", { projectId, workflowId: "browser-digest", mode: "edit" });
    // The architect's draft of the same workflow is the one to continue: no second draft of one file.
    expect(edit).toMatchObject({ draftId: first, reused: true });

    // Without the architect's draft (a file the owner wrote), the draft is made from the file and publishes over it.
    const other = JSON.parse(before) as Record<string, unknown>;
    mkdirSync(globalWorkflowDir(), { recursive: true });
    writeFileSync(join(globalWorkflowDir(), "hand-made.json"), JSON.stringify({ ...other, id: "hand-made" }));
    const made = await rpc("workflow_draft_create", { projectId, workflowId: "hand-made", mode: "edit" });
    expect(made).toMatchObject({ workflowId: "hand-made", reused: false });
    const read = await rpc("workflow_draft_get", { draftId: made.draftId });
    expect(read.draft).toMatchObject({ workflowId: "hand-made", scope: "global", status: "draft" });
    await rpc("workflow_draft_patch", { draftId: made.draftId, ops: [{ op: "update_node", id: "send", set: { maxAttempts: 3 } }] });
    expect((await rpc("workflow_draft_test", { draftId: made.draftId })).green).toBe(true);
    const published = await rpc("workflow_draft_publish", { draftId: made.draftId });
    expect(published).toMatchObject({ published: true, workflowId: "hand-made" });
    expect(JSON.parse(readFileSync(join(globalWorkflowDir(), "hand-made.json"), "utf8")).nodes.find((node: { id: string }) => node.id === "send").maxAttempts).toBe(3);
  });

  it("does not overwrite a file that changed after the draft was made", async () => {
    const { rpc, call } = await setup();
    const first = await finished(call);
    await rpc("workflow_draft_test", { draftId: first });
    await rpc("workflow_draft_publish", { draftId: first });
    const original = JSON.parse(readFileSync(join(globalWorkflowDir(), "browser-digest.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(globalWorkflowDir(), "mine.json"), JSON.stringify({ ...original, id: "mine" }));
    const made = await rpc("workflow_draft_create", { projectId, workflowId: "mine", mode: "edit" });
    // Somebody edits the file by hand meanwhile.
    writeFileSync(join(globalWorkflowDir(), "mine.json"), JSON.stringify({ ...original, id: "mine", description: { en: "edited by hand", ru: "правка руками" } }));
    await rpc("workflow_draft_patch", { draftId: made.draftId, ops: [{ op: "update_node", id: "send", set: { maxAttempts: 2 } }] });
    await rpc("workflow_draft_test", { draftId: made.draftId });
    expect(await rpc("workflow_draft_publish", { draftId: made.draftId })).toMatchObject({ published: false, reason: "file_conflict" });
    expect(JSON.parse(readFileSync(join(globalWorkflowDir(), "mine.json"), "utf8")).description.en).toBe("edited by hand");
  });
});

describe("workflow_capabilities", () => {
  it("lists skills, plugins, MCP servers, Env Catalog names (never values), machines and specialist roles", async () => {
    const { rpc } = await setup();
    const { capabilities } = await rpc("workflow_capabilities", { projectId });
    expect(capabilities.skills.items.map((item: { name: string }) => item.name)).toContain("browser-automation");
    expect(capabilities.plugins.items.map((item: { id: string }) => item.id)).toContain("browser-automation");
    expect(capabilities.mcpServers.items.map((item: { name: string }) => item.name)).toContain("tavily");
    expect(capabilities.secrets.items).toEqual([{ name: "TELEGRAM_SESSION", kind: "secret" }]);
    expect(capabilities.hosts.items[0]).toMatchObject({ id: "host_edit" });
    expect(Array.isArray(capabilities.specialists.roles)).toBe(true);
  });
});

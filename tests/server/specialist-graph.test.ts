import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../../server";
import { createRun, openDatabase, setRunThread } from "../../src/rooms/storage/database";
import { builtinWorkflow } from "../../src/rooms/workflow/builtin";
import { roleSpec } from "../../src/rooms/workflow/server/workflow-agent";
import { SPECIALIST_GRAPH } from "../../src/rooms/critique/server";
import { waitSpecialistRun } from "../../src/rooms/critique/server/specialist-graph";
import { detectRepoEdits } from "../../src/rooms/verification/server";

const projectId = "sg-project";
const pmThreadId = "sg-pm";
const runId = "sg-run";

const reply = (report: string) => `Done.\n\n\`\`\`json\n${JSON.stringify({ report, handoff: "done" })}\n\`\`\``;

let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; });

async function world() {
  const spawned: Array<Record<string, unknown>> = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: {
      threads: {
        getPluginMetadata: async ({ threadId }) => threadId === pmThreadId ? { role: "pm", lanePilotRunId: runId } : {},
        spawn: async (args) => { spawned.push(args as unknown as Record<string, unknown>); return { id: `sg-thread-${spawned.length}` }; },
        get: async ({ threadId }) => ({ id: threadId, status: "idle", projectId, environmentId: "env-pm", sourceThreadId: pmThreadId, lifecycleOwnerThreadId: pmThreadId }),
        events: { list: async ({ threadId }) => [{ type: "turn/started", threadId, seq: 1 }, { type: "turn/completed", threadId, seq: 2, data: { status: "completed" } }] },
        output: async () => ({ output: reply("Copy written to .agents/copy/h1.md") }),
      },
      environments: { get: async () => ({ id: "env-pm", hostId: "local-host", path: process.cwd(), status: "ready" }) },
    },
  });
  await plugin(bb);
  dispose = () => harness.lifecycle.dispose();
  const db = openDatabase(bb);
  createRun(db, runId, projectId, "cli");
  setRunThread(db, runId, pmThreadId);
  const call = async (name: string, params: Record<string, unknown>, thread = pmThreadId) =>
    JSON.parse(String(await harness.behavior.callAgentTool(name, params, { threadId: thread, projectId }))) as Record<string, any>;
  return { bb, db, spawned, call };
}

describe("the graph behind lane_pilot_specialist", () => {
  it("is a starter graph with one agent step whose role comes from the input", () => {
    const graph = builtinWorkflow(SPECIALIST_GRAPH)!;
    expect(graph).toMatchObject({ id: "specialist", startedBy: "lane_pilot_specialist", status: "published" });
    expect(graph.nodes.map((node) => node.id)).toEqual(["brief", "work", "done"]);
    expect(graph.nodes.find((node) => node.id === "work")).toMatchObject({ type: "agent", role: "specialist:{{$inputs.role}}" });
  });

  it("keeps the role lines of the project in the first message, names the thread by the title, and does not repeat the task as graph inputs", async () => {
    const t = await world();
    await t.bb.storage.kv.set(`lp.role.lines:${projectId}:copy-lead`, ["2026-10-20 never promise a price in an H1"] as never);
    const started = await t.call("lane_pilot_specialist", { role: "copy-lead", task: "Write three H1 variants for /pricing.", title: "H1 for pricing" });
    const prompt = String(t.spawned[0]!.prompt);
    expect(prompt).toContain("never promise a price in an H1");
    expect(prompt.match(/Write three H1 variants/g)).toHaveLength(1);
    expect(prompt).toContain("write only your deliverable");
    expect(prompt).not.toContain("<inputs>");
    expect(prompt).not.toContain("- task:");
    expect(prompt).toContain('step "work" (H1 for pricing)');
    expect(t.spawned[0]!.pluginMetadata).toMatchObject({ lanePilotWorkflowRunId: started.workflowRunId, lanePilotWorkflowNode: "work", role: "specialist", specialist: "copy-lead" });
  });

  it("starts the same task of the same specialist once", async () => {
    const t = await world();
    const first = await t.call("lane_pilot_specialist", { role: "copy-lead", task: "Write three H1 variants for /pricing." });
    const again = await t.call("lane_pilot_specialist", { role: "copy-lead", task: "Write three H1 variants for /pricing." });
    expect(again.workflowRunId).toBe(first.workflowRunId);
    expect(t.spawned).toHaveLength(1);
  });

  it("charges the specialist's thread to the run it belongs to", async () => {
    const t = await world();
    const started = await t.call("lane_pilot_specialist", { role: "seo-specialist", task: "Check titles." });
    await t.call("lane_pilot_wait_specialist", { threadId: started.threadId, timeoutSec: 5 });
    const row = t.db.prepare("SELECT status FROM lane_pilot_wf_run WHERE id=?").get(started.workflowRunId) as { status: string };
    expect(row.status).toBe("succeeded");
    const step = t.db.prepare("SELECT receipt_json FROM lane_pilot_wf_step WHERE run_id=? AND node_id='work'").get(started.workflowRunId) as { receipt_json: string };
    expect(JSON.parse(step.receipt_json)).toMatchObject({ threadId: started.threadId });
  });

  it("answers for a thread that no graph run started (running when the graph came in), and refuses a run of another project", async () => {
    const t = await world();
    expect(await t.call("lane_pilot_wait_specialist", { threadId: "old-thread", timeoutSec: 5 })).toMatchObject({ threadId: "old-thread", state: "done" });
    const started = await t.call("lane_pilot_specialist", { role: "seo-specialist", task: "Check titles." });
    t.db.prepare("UPDATE lane_pilot_wf_run SET project_id='other' WHERE id=?").run(started.workflowRunId);
    expect(await t.call("lane_pilot_wait_specialist", { threadId: started.threadId, timeoutSec: 5 })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/not_found/) } });
  });
});

describe("what the wait answers when the run ended badly", () => {
  const ended = (status: string, error: string | null) => {
    const ctx = { db: { prepare: () => ({ get: () => ({ project_id: projectId }) }) }, bb: { storage: { kv: { get: async () => "sg-thread-1" } } }, isDisposed: () => false } as never;
    const services = { workflowEngine: { get: () => ({ status, error, reason: null, output: null }) } } as never;
    return waitSpecialistRun(ctx, services, { projectId, runId: "wfrun_x", timeoutSec: 5 });
  };

  it("a repo edit outside the specialist's files is blocked with the files, as before", async () => {
    const answer = await ended("failed", "repo_edited: the specialist:copy-lead helper edited repository files it may not touch: src/a.ts, docs/b.md");
    expect(answer).toMatchObject({ state: "blocked", reason: "repo_edited", files: ["src/a.ts", "docs/b.md"], threadId: "sg-thread-1", workflowRunId: "wfrun_x" });
    expect(String(answer.output)).toContain("Helper edited repository files: src/a.ts, docs/b.md");
  });

  it("any other failure is failed with the step's own message", async () => {
    expect(await ended("failed", "thread_failed: provider error")).toMatchObject({ state: "failed" });
    expect(await ended("blocked", null)).toMatchObject({ state: "failed" });
  });
});

describe("design-lead and DESIGN.md", () => {
  const edits = (role: string, files: string[]) => detectRepoEdits(new Set<string>(), new Set(files), roleSpec(role).editable);

  it("design-lead may write DESIGN.md (root and an app's docs) next to .agents/, in the graph and in the tool's prompt alike", () => {
    const design = roleSpec("specialist:design-lead");
    for (const file of ["DESIGN.md", "apps/web/docs/DESIGN.md", ".agents/design/a.html", ".bb/chats/x/notes.md"]) expect(design.editable(file), file).toBe(true);
    for (const file of ["src/a.ts", "docs/index.md", "README.md", "DESIGN.md.bak", "notes/DESIGN.mdx"]) expect(design.editable(file), file).toBe(false);
    expect(edits("specialist:design-lead", ["DESIGN.md", "src/a.ts"])).toEqual(["src/a.ts"]);
  });

  it("no other specialist, bundled or the owner's, may write DESIGN.md", () => {
    for (const role of ["specialist:copy-lead", "specialist:seo-specialist", "specialist:tavily", "specialist:video-lead", "specialist:blog-writer"]) expect(roleSpec(role).editable("DESIGN.md"), role).toBe(false);
  });
});

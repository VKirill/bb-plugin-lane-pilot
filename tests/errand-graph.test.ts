import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { WorkflowEngine, registerPureActions } from "@lane-pilot/workflow-engine";
import { createRun, openDatabase, setRunThread } from "../src/rooms/storage/database";
import { mountErrands } from "../src/rooms/qa/server/errands";
import { builtinWorkflow } from "../src/rooms/workflow/builtin";
import { validateWorkflow } from "@lane-pilot/workflow-engine";
import { coreRequiredSessionAdvertisement } from "../src/rooms/native-agent/helper-context";

/**
 * The errand as a graph (workflows/errand.json): the account check, the helper's step wrapping the errand core, and the PM tools that start and read the run.
 * The engine, the journal and the errand core are the real ones; the machine, BB's threads and the catalog are doubles.
 */
const PROJECT = "proj-1";
const PM = "pm-1";
const RUN = "lprun-1";
const TASK = "Open the CRM in the owner's Chrome and report the number of new leads.";

type Gate = { missing: string[]; denied: string[]; wrongKind: string[]; unavailable: boolean; catalog?: Array<{ name: string; kind: string }> };

function world(options: { pm?: boolean; output?: string; gate?: (names: string[]) => Gate; requiredPolicy?: boolean } = {}) {
  const state = { ended: false, output: options.output ?? "Found 12 new leads.\nERRAND: done", status: "", spawned: [] as Array<Record<string, any>>, stopped: [] as string[], disposed: false, issued: [] as string[] };
  const withPm = options.pm !== false;
  const sdk = {
      providers: { list: async () => [] },
      projects: { get: async () => ({ sources: [{ hostId: "host-1", path: "/proj" }] }) },
      threads: {
        get: async ({ threadId }: { threadId: string }) => ({ id: threadId, status: "idle", projectId: PROJECT, environmentId: "env-1" }),
        getPluginMetadata: async () => ({}),
        spawn: async (args: unknown) => { state.spawned.push(args as Record<string, any>); return { id: `errand-thr-${state.spawned.length}` }; },
        stop: async ({ threadId }: { threadId: string }) => { state.stopped.push(threadId); },
        output: async () => ({ output: state.output }),
        events: { list: async ({ threadId }: { threadId: string }) => state.ended ? [{ type: "turn/started", threadId, seq: 1 }, { type: "turn/completed", threadId, seq: 2, data: { status: "completed" } }] : [{ type: "turn/started", threadId, seq: 1 }] },
      },
      environments: { get: async () => ({ id: "env-1", path: "/checkout", hostId: "host-1" }) },
    } as never;
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot", sdk });
  // A core that narrows helper sessions (VK required session policy): the spawn then carries the role's policy.
  if (options.requiredPolicy) Object.assign(bb.agents, { experimental_vkRequiredSessionPolicy: () => coreRequiredSessionAdvertisement() });
  const db = openDatabase(bb);
  if (withPm) { createRun(db, RUN, PROJECT, "cli", "/checkout"); setRunThread(db, RUN, PM); }
  const commands: string[] = [];
  const host = { call: async (_method: string, input: { command: string }) => { commands.push(input.command); return { hostId: "host-1", exitCode: 0, stdout: state.status, stderr: "" }; } };
  const gate = options.gate ?? ((names: string[]) => ({ missing: [], denied: [], wrongKind: [], unavailable: false, catalog: names.map((name) => ({ name, kind: "login" })) }));
  const secrets = { check: async (input: { declared: string[] }) => gate(input.declared), record: async (name: string) => { state.issued.push(name); } };
  const ctxFor = (instanceBb: typeof bb) => ({ bb: instanceBb, db, host, secrets, isDisposed: () => state.disposed, log: () => undefined } as never);
  const runtimeFor = (ctx: never) => withPm ? { ctx, pmThreadId: PM, projectId: PROJECT, runId: RUN } : { ctx, pmThreadId: null, projectId: PROJECT, runId: null };

  /** One plugin instance: an engine on the shared journal with the errand executors on it. A reload is a second instance on the same database. */
  function instance(instanceBb = bb, instanceHarness = harness) {
    const engine = new WorkflowEngine({ db, harnessVersion: "test", resolveWorkflow: (id) => builtinWorkflow(id) });
    registerPureActions(engine);
    // The api-recon graph's helper step (an agent node): started, never answering; the tests only read where the errand went.
    engine.register("agent", { reentrant: true, run: () => new Promise(() => undefined) } as never);
    const ctx = ctxFor(instanceBb);
    const services = { workflowEngine: engine } as never;
    const errands = mountErrands(ctx, services);
    const call = async (name: string, params: Record<string, unknown>) =>
      JSON.parse(String(await instanceHarness.behavior.callAgentTool(name, params, { threadId: PM, projectId: PROJECT }))) as Record<string, any>;
    return { engine, errands, ctx, services, call };
  }
  const first = instance();
  const call = first.call;
  /** The plugin after a reload: a new host and engine on the same database. */
  const reloaded = () => { const host2 = createFakePluginHost({ pluginId: "lane-pilot", sdk }); return instance(host2.bb, host2.harness); };
  const runs = () => db.prepare("SELECT id, workflow_id, status, idem_key FROM lane_pilot_wf_run").all() as Array<{ id: string; workflow_id: string; status: string; idem_key: string }>;
  return { state, db, bb, first, reloaded, call, runs, commands, runtimeFor, withPm };
}

describe("the errand graph", () => {
  it("an errand that maps a web service's API from its pages runs as the api-recon graph; one that changes things, has no address or is another job stays an errand (magicseo replay, 2026-10-31)", async () => {
    // The PM's own brief of the replay, cut: the router sent it to security-audit at 100 before the api-recon rule (it names auth and CSRF).
    const recon = "Owner request (this chat): scan the MagicSEO personal cabinet https://lk.magicseo.ru/ — every request it makes, its features and mechanics — so we can later build our own API/automation service on top of it. THIS ERRAND IS READ-ONLY RECON. Map the auth: token, cookies, CSRF.";
    const w = world();
    const started = await w.call("lane_pilot_errand", { task: recon, accounts: ["MAGICSEO_LOGIN"] });
    expect(started).toMatchObject({ workflowRunId: expect.stringMatching(/^wfrun_/), state: "running", workflow: "api-recon" });
    expect(w.runs()).toEqual([expect.objectContaining({ workflow_id: "api-recon", idem_key: expect.stringMatching(/^api-recon:lprun-1:/) })]);
    expect(w.state.spawned).toEqual([]);
    const inputs = JSON.parse((w.db.prepare("SELECT inputs_json FROM lane_pilot_wf_run").get() as { inputs_json: string }).inputs_json);
    expect(inputs).toMatchObject({ url: "https://lk.magicseo.ru/", account: "MAGICSEO_LOGIN" });

    for (const [task, authorized] of [[recon, true], [recon.replace("https://lk.magicseo.ru/", "the MagicSEO cabinet"), false], [TASK, false]] as const) {
      const other = world();
      expect(await other.call("lane_pilot_errand", { task, authorized })).not.toHaveProperty("workflow");
      expect(other.runs()).toEqual([expect.objectContaining({ workflow_id: "errand" })]);
    }
  });

  it("is a built-in starter graph (offered to no one) that passes the validator and runs accounts, work, emit", () => {
    const errand = builtinWorkflow("errand")!;
    expect(errand).toMatchObject({ id: "errand", startedBy: "lane_pilot_errand", status: "published" });
    expect(errand.nodes.map((node) => node.id)).toEqual(["accounts", "work", "done"]);
    expect(errand.nodes.find((node) => node.id === "work")).toMatchObject({ type: "agent", uses: "lp.errand", role: "errand" });
    expect(validateWorkflow(errand).filter((problem) => problem.level === "error")).toEqual([]);
  });

  it("an ERRAND: done marker is the status done; wait_errand answers by the run id and by the thread id with the same report", async () => {
    const w = world();
    const started = await w.call("lane_pilot_errand", { task: TASK });
    expect(started).toMatchObject({ workflowRunId: expect.stringMatching(/^wfrun_/), threadId: "errand-thr-1", state: "running", link: "@thread:errand-thr-1" });
    expect(w.runs()).toEqual([expect.objectContaining({ workflow_id: "errand", idem_key: expect.stringMatching(/^errand:lprun-1:/) })]);

    // While the helper works, the wait says so.
    expect(await w.call("lane_pilot_wait_errand", { workflowRunId: started.workflowRunId, timeoutSec: 5 })).toMatchObject({ workflowRunId: started.workflowRunId, threadId: "errand-thr-1", state: "running" });

    w.state.ended = true;
    const byRun = await w.call("lane_pilot_wait_errand", { workflowRunId: started.workflowRunId, timeoutSec: 30 });
    expect(byRun).toMatchObject({ workflowRunId: started.workflowRunId, threadId: "errand-thr-1", state: "done" });
    expect(byRun.output).toContain("Found 12 new leads.");
    const byThread = await w.call("lane_pilot_wait_errand", { threadId: "errand-thr-1", timeoutSec: 30 });
    expect(byThread).toEqual(byRun);
    expect(w.first.engine.get(started.workflowRunId)).toMatchObject({ status: "succeeded", output: { state: "done", thread_id: "errand-thr-1" } });
  });

  it("a report without the closing line is blocked no_marker; one that says blocked carries the helper's reason", async () => {
    const lost = world({ output: "I looked at the page but the login asked for a code." });
    const a = await lost.call("lane_pilot_errand", { task: TASK });
    lost.state.ended = true;
    expect(await lost.call("lane_pilot_wait_errand", { workflowRunId: a.workflowRunId, timeoutSec: 30 })).toMatchObject({ state: "blocked", reason: expect.stringContaining("no_marker") });
    const stuck = world({ output: "ERRAND: blocked: the page asks for a password" });
    const b = await stuck.call("lane_pilot_errand", { task: TASK });
    stuck.state.ended = true;
    expect(await stuck.call("lane_pilot_wait_errand", { workflowRunId: b.workflowRunId, timeoutSec: 30 })).toMatchObject({ state: "blocked", reason: "the page asks for a password" });
  });

  it("a helper that changed the repository ends blocked repo_edited with the files, whatever its marker says", async () => {
    const w = world();
    const started = await w.call("lane_pilot_errand", { task: TASK });
    // The checkout was clean when the helper started (the snapshot is in the step's journal); it is not any more.
    w.state.status = " M src/app.ts\n?? notes.txt";
    w.state.ended = true;
    const waited = await w.call("lane_pilot_wait_errand", { workflowRunId: started.workflowRunId, timeoutSec: 30 });
    expect(waited).toMatchObject({ state: "blocked", reason: "repo_edited", files: ["notes.txt", "src/app.ts"] });
  });

  it("an account that is missing starts no run and no thread, and says what to do; one that is allowed is noted as issued once", async () => {
    const w = world({ gate: (names) => names.includes("GONE") ? { missing: ["GONE"], denied: [], wrongKind: [], unavailable: false } : { missing: [], denied: [], wrongKind: [], unavailable: false, catalog: names.map((name) => ({ name, kind: "ssh" })) } });
    const refused = await w.call("lane_pilot_errand", { task: TASK, accounts: ["GONE"] });
    expect(refused).toMatchObject({ state: "blocked", reason: expect.stringContaining("GONE") });
    expect(w.runs()).toEqual([]);
    expect(w.state.spawned).toEqual([]);

    const started = await w.call("lane_pilot_errand", { task: TASK, accounts: ["DEPLOY_KEY"] });
    expect(started.threadId).toBe("errand-thr-1");
    expect(w.state.issued).toEqual(["DEPLOY_KEY"]);
    expect(String(w.state.spawned[0]!.prompt)).toContain("DEPLOY_KEY (ssh)");
  });

  it("the helper loads the BB plugins, skills and MCP servers the errand names on top of its role's; none named keeps the role's alone", async () => {
    const w = world({ requiredPolicy: true });
    await w.call("lane_pilot_errand", { task: TASK });
    const plain = w.state.spawned[0]!.experimental_vkRequiredSessionPolicy.policy;
    expect(plain.bbPlugins.names).not.toContain("image-studio");
    expect(plain.mcpServers.names).toEqual(["bb-bridge"]);

    await w.call("lane_pilot_errand", { task: `${TASK} Then draw it.`, plugins: ["image-studio"], mcp: ["blender"], skills: ["blender-modeler"] });
    const named = w.state.spawned[1]!.experimental_vkRequiredSessionPolicy.policy;
    expect(named.bbPlugins.names).toEqual(expect.arrayContaining(["browser-automation", "env-catalog", "image-studio"]));
    expect(named.mcpServers.names).toEqual(expect.arrayContaining(["bb-bridge", "blender"]));
    expect(named.skills.names).toEqual(expect.arrayContaining(["computer-use", "blender-modeler"]));
  });

  it("the same task asked twice is the same run and the same thread; another task is another run", async () => {
    const w = world();
    const one = await w.call("lane_pilot_errand", { task: TASK });
    const two = await w.call("lane_pilot_errand", { task: TASK });
    expect(two.workflowRunId).toBe(one.workflowRunId);
    expect(two.threadId).toBe(one.threadId);
    expect(w.state.spawned).toHaveLength(1);
    const other = await w.call("lane_pilot_errand", { task: `${TASK} Also list the lost ones.` });
    expect(other.workflowRunId).not.toBe(one.workflowRunId);
    expect(w.runs()).toHaveLength(2);
  });

  it("the helper's thread belongs to the graph step: quiet for the PM, filed under it and named for the run", async () => {
    const w = world();
    const started = await w.call("lane_pilot_errand", { task: TASK });
    const spawned = w.state.spawned[0]!;
    expect(spawned.pluginMetadata).toMatchObject({ role: "errand", lanePilotWorkflowRunId: started.workflowRunId, lanePilotWorkflowNode: "work", lanePilotRunId: RUN, parentPmThreadId: PM });
    expect(spawned.environment).toEqual({ type: "reuse", environmentId: "env-1" });
  });

  it("without a PM chat the run works: the helper is a hidden thread in the project's own folder", async () => {
    const w = world({ pm: false });
    const started = w.first.errands.startRun({ projectId: PROJECT, pmThreadId: null, runId: null, key: "errand:nopm:1", task: TASK, authorized: false, accounts: [], detached: true });
    const summary = await new Promise<unknown>((resolve) => { const timer = setInterval(() => { if (w.state.spawned.length) { clearInterval(timer); resolve(null); } }, 20); });
    void summary;
    w.state.ended = true;
    await w.first.engine.idle();
    expect(w.first.engine.get(started.runId)).toMatchObject({ status: "succeeded", output: { state: "done" } });
    const spawned = w.state.spawned[0]!;
    expect(spawned).toMatchObject({ visibility: "hidden", projectId: PROJECT, environment: { type: "host", hostId: "host-1", workspace: { type: "unmanaged", path: "/proj" } } });
    expect(spawned.pluginMetadata).not.toHaveProperty("parentPmThreadId");
    expect(spawned.pluginMetadata).not.toHaveProperty("lanePilotRunId");
  });

  it("a scheduled run is keyed with the schedule prefix, hidden with no parent chat, and says which schedule it is for", async () => {
    const w = world();
    const started = w.first.errands.startRun({ projectId: PROJECT, pmThreadId: PM, runId: RUN, key: "sch_1:1790000000000", task: TASK, authorized: false, accounts: [], detached: true, schedule: { id: "sch_1", runKey: "sch_1:1790000000000" } });
    for (let i = 0; i < 200 && !w.state.spawned.length; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(w.runs()[0]).toMatchObject({ idem_key: `wf-schedule:${PROJECT}:errand:sch_1:1790000000000` });
    const spawned = w.state.spawned[0]!;
    expect(spawned).toMatchObject({ visibility: "hidden" });
    expect(spawned.pluginMetadata).toMatchObject({ origin: "schedule", scheduleId: "sch_1", scheduleRunKey: "sch_1:1790000000000", lanePilotWorkflowRunId: started.runId });
    expect(spawned.pluginMetadata).not.toHaveProperty("parentPmThreadId");
    w.state.ended = true;
    await w.first.engine.idle();
  });

  it("a reload in the middle resumes the run: no second thread, and the checkout snapshot from before the helper started is the one compared", async () => {
    const w = world();
    const started = await w.call("lane_pilot_errand", { task: TASK });
    expect(w.state.spawned).toHaveLength(1);
    // The plugin goes away mid-step; the helper keeps working and, meanwhile, edits the checkout.
    w.first.engine.dispose();
    w.state.status = "?? stray.txt";
    w.state.ended = true;
    const second = w.reloaded();
    const taken = await second.engine.resume({ takeOver: true, runtimeFor: () => w.runtimeFor(second.ctx) });
    expect(taken).toContain(started.workflowRunId);
    await second.engine.idle();
    expect(w.state.spawned).toHaveLength(1);
    // Taken again after the reload, the snapshot would already hold stray.txt and the edit would pass; it comes from the journal.
    expect(second.engine.get(started.workflowRunId)).toMatchObject({ status: "succeeded", output: { state: "blocked", reason: "repo_edited", files: ["stray.txt"] } });
    expect(await second.call("lane_pilot_wait_errand", { threadId: "errand-thr-1", timeoutSec: 10 })).toMatchObject({ state: "blocked", reason: "repo_edited" });
  });

  it("a thread an earlier version started (no run) is still waited on as before", async () => {
    const w = world();
    w.state.ended = true;
    const waited = await w.call("lane_pilot_wait_errand", { threadId: "legacy-thread", timeoutSec: 10 });
    expect(waited).toMatchObject({ threadId: "legacy-thread", state: "done" });
  });

  it("wait_errand needs an id", async () => {
    const w = world();
    expect(await w.call("lane_pilot_wait_errand", { timeoutSec: 5 })).toMatchObject({ ok: false, error: { code: "wait_errand_needs_an_id" } });
  });

  it("stopping the run stops the helper thread", async () => {
    const w = world();
    const started = await w.call("lane_pilot_errand", { task: TASK });
    w.first.engine.cancel(started.workflowRunId, "stopped by the test");
    for (let i = 0; i < 200 && !w.state.stopped.length; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(w.state.stopped).toEqual(["errand-thr-1"]);
  });
});

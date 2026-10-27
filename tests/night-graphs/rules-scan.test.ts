import { describe, expect, it } from "vitest";
import { validateWorkflow } from "@lane-pilot/workflow-engine";
import { createRuleScan } from "../../src/rooms/self-repair/server/rule-scan";
import { mountNightGraphs } from "../../src/rooms/night-graphs/server";
import { builtinWorkflow } from "../../src/rooms/workflow/builtin";
import { listRuleProposals } from "@lane-pilot/run-insights";
import { nightWorld } from "./world";

const PROJECT = "proj-1";
const RULE = JSON.stringify({ rules: [{ rule: "Run the spec next to the file before you answer.", why: "x", evidence: ["t1"], also_seen: [] }], not_writer: [] });

function setup(answers: Array<string | Error> = []) {
  const w = nightWorld({ answers });
  w.services.ruleScan = createRuleScan(w.ctx, w.services);
  mountNightGraphs(w.ctx, w.services);
  const scan = w.services.ruleScan as ReturnType<typeof createRuleScan>;
  /** Replaces the planning step by a fixed plan (the real one reads the failures of the project; its output is what the steps below consume). */
  const plan = (jobs: unknown[]) => { (scan.graph as any).collectScan = async () => ({ state: "ok", triaged: 4, groups: jobs.length, jobs, hostId: "host-1", path: "/proj", analyzer: { providerId: "codex", model: "gpt-6-luna", reasoningLevel: "high", serviceTier: "fast" } }); };
  const settle = async () => {
    for (let i = 0; i < 300; i += 1) { await w.engine.idle(); const state = (await scan.scanState(PROJECT)).state; if (state !== "running") return; await new Promise((resolve) => setTimeout(resolve, 10)); }
    throw new Error("the scan did not settle");
  };
  return { w, scan, plan, settle };
}
const job = (id: string, extra: Record<string, unknown> = {}) => ({
  id, kind: "analyze", title: `Writer mistakes · ${id}`, prompt: `evidence of ${id}`, category: "skipped_spec", scope: [],
  known: [{ taskId: "t1", runId: "run-1", attemptId: "att-1", failedAt: 1_000, reason: "spec not run" }, { taskId: "t2", runId: "run-1", attemptId: "att-2", failedAt: 2_000, reason: "spec not run" }], ...extra,
});

describe("the rules scan graph", () => {
  it("is a built-in starter graph (offered to no one) that passes the validator: collect, analyze, apply", () => {
    const scan = builtinWorkflow("lp.rules-scan")!;
    expect(scan).toMatchObject({ id: "lp.rules-scan", startedBy: "rules-nightly", status: "published" });
    expect(scan.nodes.map((node) => node.id)).toEqual(["collect", "analyze", "apply", "done"]);
    expect(scan.nodes.find((node) => node.id === "analyze")).toMatchObject({ type: "agent", uses: "lp.rules-analyzer", role: "rules-analyzer" });
    expect(validateWorkflow(scan).filter((problem) => problem.level === "error")).toEqual([]);
    expect(validateWorkflow(builtinWorkflow("lp.rules-ask")!).filter((problem) => problem.level === "error")).toEqual([]);
  });

  it("a night with nothing to learn is a succeeded run and a done scan; the same night started again finds the run", async () => {
    const { w, scan, settle } = setup();
    expect(await scan.startScan(PROJECT, "en", { night: "2026-10-27" })).toMatchObject({ started: true });
    await settle();
    expect(await scan.scanState(PROJECT)).toMatchObject({ state: "done", proposals: 0, reason: null });
    expect(w.runs("lp.rules-scan")).toEqual([expect.objectContaining({ status: "succeeded", idem_key: `rules-scan:${PROJECT}:2026-10-27` })]);
    expect(await scan.startScan(PROJECT, "en", { night: "2026-10-27" })).toMatchObject({ started: false });
    expect(w.runs("lp.rules-scan")).toHaveLength(1);
    // The Rescan button has no night: its own run.
    await scan.startScan(PROJECT, "en");
    await settle();
    expect(w.runs("lp.rules-scan")).toHaveLength(2);
  });

  it("the analyzer is one hidden parentless thread of the graph step; its answer becomes a proposal on trial", async () => {
    const { w, scan, plan, settle } = setup([RULE]);
    plan([job("analyze:a")]);
    await scan.startScan(PROJECT, "ru", { night: "2026-10-27" });
    await settle();
    const [run] = w.runs("lp.rules-scan");
    expect(run).toMatchObject({ status: "succeeded" });
    expect(w.state.spawned).toHaveLength(1);
    const spawned = w.state.spawned[0]!;
    expect(spawned).toMatchObject({ visibility: "hidden", projectId: PROJECT, environment: { type: "host", hostId: "host-1", workspace: { type: "unmanaged", path: "/proj" } } });
    expect(spawned.pluginMetadata).toMatchObject({ role: "rules-analyzer", lanePilotWorkflowRunId: run!.id, lanePilotWorkflowNode: "analyze", category: "skipped_spec" });
    expect(spawned.pluginMetadata).not.toHaveProperty("parentPmThreadId");
    // The model is the project's analyzer, else the role table's row (Luna, high).
    expect(spawned).toMatchObject({ model: "gpt-6-luna", providerId: "codex" });
    const proposals = listRuleProposals(w.db, PROJECT);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ rule: "Run the spec next to the file before you answer.", state: "accepted", decidedBy: "auto" });
    expect(await scan.scanState(PROJECT)).toMatchObject({ state: "done", proposals: 1, adopted: 1 });
  });

  it("an analyzer call that fails does not corrupt the scan: the other answers are applied, the scan and the run end failed", async () => {
    const { w, scan, plan, settle } = setup([RULE, "this is not json"]);
    plan([job("analyze:a"), job("analyze:b")]);
    await scan.startScan(PROJECT, "en", { night: "2026-10-27" });
    await settle();
    expect(listRuleProposals(w.db, PROJECT)).toHaveLength(1);
    const state = await scan.scanState(PROJECT);
    expect(state).toMatchObject({ state: "failed", proposals: 1 });
    expect(state.reason).toContain("analyzer_failed: analyze:b");
    expect(w.runs("lp.rules-scan")).toEqual([expect.objectContaining({ status: "failed" })]);
  });

  it("when every analyzer call fails the run fails at the analyze step and nothing is applied", async () => {
    const { w, scan, plan, settle } = setup([new Error("spawn refused"), new Error("spawn refused")]);
    plan([job("analyze:a"), job("analyze:b")]);
    await scan.startScan(PROJECT, "en", { night: "2026-10-27" });
    await settle();
    expect(listRuleProposals(w.db, PROJECT)).toHaveLength(0);
    expect(await scan.scanState(PROJECT)).toMatchObject({ state: "failed" });
    const run = w.engine.get(w.runs("lp.rules-scan")[0]!.id)!;
    expect(run).toMatchObject({ status: "failed", failedNode: "analyze" });
    expect(run.error).toContain("rules analyzer failed: spawn refused");
  });

  it("a scan that cannot plan (no machine for the groups) is recorded failed and is a failed graph run", async () => {
    const { w, scan, plan, settle } = setup();
    w.services.resolveProjectWriterHost = async () => null;
    // The real collect step: a group with no host fails before any thread.
    (scan.graph as any).collectScan = async (projectId: string) => { await scan.graph.failScan(projectId, "no_host"); throw new Error("no_host"); };
    await scan.startScan(PROJECT, "en", { night: "2026-10-28" });
    await settle();
    expect(await scan.scanState(PROJECT)).toMatchObject({ state: "failed", reason: "no_host" });
    expect(w.engine.get(w.runs("lp.rules-scan")[0]!.id)).toMatchObject({ status: "failed", failedNode: "collect" });
    expect(w.state.spawned).toHaveLength(0);
  });

  it("the learning review's model call is the one-step graph lp.rules-ask and returns the analyzer's text", async () => {
    const { w, scan } = setup(["{\"items\":[]}"]);
    const place = { hostId: "host-1", path: "/proj" };
    const analyzer = (await scan.analyzerFor(PROJECT))!;
    expect(analyzer).toMatchObject({ providerId: "codex", model: "gpt-6-luna", reasoningLevel: "high", serviceTier: "fast" });
    const text = await scan.runAnalyzer(PROJECT, "Learning from owner messages · 2 owner messages", "Extract", place, analyzer, { learning: true });
    expect(text).toBe("{\"items\":[]}");
    expect(w.runs("lp.rules-ask")).toEqual([expect.objectContaining({ status: "succeeded" })]);
    expect(w.state.spawned[0]!.pluginMetadata).toMatchObject({ role: "rules-analyzer", learning: true, lanePilotWorkflowNode: "ask" });
    expect(w.state.spawned[0]!.pluginMetadata).not.toHaveProperty("parentPmThreadId");
  });

  it("the same question of the same day is the same run (a reload or a repeat asks nothing twice); another question is another run; a failed run is retried", async () => {
    const { w, scan } = setup(["{\"a\":1}", "{\"b\":2}", "{\"c\":3}"]);
    const place = { hostId: "host-1", path: "/proj" };
    const analyzer = (await scan.analyzerFor(PROJECT))!;
    const ask = (prompt: string) => scan.runAnalyzer(PROJECT, "Learning from owner messages · 2 owner messages", prompt, place, analyzer, { learning: true });
    expect(await ask("Extract")).toBe("{\"a\":1}");
    expect(await ask("Extract")).toBe("{\"a\":1}");
    expect(w.state.spawned).toHaveLength(1);
    expect(w.runs("lp.rules-ask")).toHaveLength(1);
    expect(w.runs("lp.rules-ask")[0]).toMatchObject({ idem_key: expect.stringMatching(/^rules-ask:[^:]+:\d{4}-\d{2}-\d{2}:[0-9a-f]{16}$/) });
    expect(await ask("Extract differently")).toBe("{\"b\":2}");
    expect(w.runs("lp.rules-ask")).toHaveLength(2);
  });

  it("a failed run of the question does not stand in the way of asking it again", async () => {
    const { w, scan } = setup([new Error("spawn_failed"), "{\"ok\":true}"]);
    const place = { hostId: "host-1", path: "/proj" };
    const analyzer = (await scan.analyzerFor(PROJECT))!;
    const ask = () => scan.runAnalyzer(PROJECT, "Learning from owner messages · 1 owner message", "Extract", place, analyzer, { learning: true });
    await expect(ask()).rejects.toThrow();
    expect(await ask()).toBe("{\"ok\":true}");
    expect(w.runs("lp.rules-ask").map((row) => row.status)).toEqual(["failed", "succeeded"]);
  });
});

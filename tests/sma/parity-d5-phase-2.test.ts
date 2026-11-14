import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { createCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../server";
import { createPhaseDriver } from "../phase-driver";
import {
  ACCEPTANCE_LINES, acceptanceLines, nextAction, pieceProblems, planGate, planSignature,
  type Phase, type PhaseRecord, type PlanItem, type TaskFact,
} from "../../src/rooms/phase/logic";
import {
  ANIMATOR_FREQUENT_RULE, ANIMATOR_LAW, ambiguityScore, designPoints, markUatLine, nextRoadmapRow, oneLine, ownsPathProblems, parkRoadmapRow,
  parseState, planText, piecePlan, motionRows, roadmapAnalysis, roadmapSection, sameStateIgnoringTime, specText, stateBlockText, stateText,
  STATE_BLOCK_END, STATE_BLOCK_START, templateFill, threatClosureGaps, uatText,
} from "../../src/rooms/phase/stages";
import { laneSessionOverlayPrompt } from "../../src/rooms/native-agent/native-agent-overlay";
import { createAttempt, createRun, createTask, openDatabase, setRunThread } from "../../src/rooms/plugin-db";
import { getPhase, insertPhase, listParts, savePhase } from "../../src/rooms/phase/store";
import { installDocs, GENERATED } from "../../src/rooms/phase/server/driver-docs";
import { createAutoStages } from "../../src/rooms/phase/server/auto-stages";
import { candidatePath } from "../../src/rooms/phase/server/candidate";
import { phaseToolParams } from "../../src/rooms/phase/server/tool";
import { phaseRpc } from "../../src/rooms/phase/server/rpc";
import { builtinWorkflow } from "../../src/rooms/workflow/builtin";
import { chainRuntimeFor, registerChainExecutors } from "../../src/rooms/workflow/server/workflow-executors";
import { createWorkflowAgents } from "../../src/rooms/workflow/server/workflow-agent";
import { readBoundedFile, writePhaseBook } from "../../src/rooms/host-worker/host-handlers";
import { recordStage } from "../../src/rooms/runs/server";
import { WorkflowEngine, registerPureActions, registerReducers } from "@lane-pilot/workflow-engine";
import { chainStore, runSim } from "../workflow/chain-harness";
import { out, pathOf } from "../workflow/chain-helpers";
import { sha256Hex } from "@lane-pilot/kit";

const phase = (record: PhaseRecord, stage: Phase["stage"] = "planning", over: Partial<Phase> = {}): Phase => ({
  id: "ph_sma", projectId: "p", pmThreadId: "t", runId: "r", title: "Sum", goal: "sums", stage, state: "active", record, edition: 1, createdAt: 0, updatedAt: 0, ...over,
});
const item = (id: string, over: Partial<PlanItem> = {}): PlanItem => ({
  id, title: id, wave: 1, promise: { given: "g", when: "w", then: `then-${id}` },
  task: { id, project_cwd: "/repo", owns_paths: ["src/**"], verification: [{ command: "npm test" }], acceptance: [`acc-${id}`] }, ...over,
});
const fact = (taskId: string, over: Partial<TaskFact> = {}): TaskFact => ({ taskId, state: "accepted", planFact: "passed", verification: "passed", codeCritique: "passed", browserQa: "passed", qaPlanned: true, ...over });
const SHA = "a".repeat(64);
const ctxReady = () => ({ docs: [], sha: "ctx", signedAt: 1, legacy: true });
const planRec = (items: PlanItem[], over: Partial<NonNullable<PhaseRecord["plan"]>> = {}): NonNullable<PhaseRecord["plan"]> => ({
  items, contextSha: "ctx", sha: planSignature(items, "ctx"), critique: { decision: "approve", by: "c", independence: { ok: true, why: "" } },
  objective: "o", premortem: ["a", "b", "c"], ...over });

type DriverOptions = { settings?: Record<string, unknown>; failRead?: string[]; failWrite?: boolean; projects?: Record<string, string> };
/** Every phase switch opted out with the word «off» (and no branch): the old path an install took before the switches were on by default. */
const PHASE_OFF: Record<string, unknown> = Object.fromEntries([...["diagnose", "gray_areas", "research", "pattern_map", "validation", "draw_material", "plan_bounce",
  "design_points", "doc_files", "ambiguity_gate", "piece_notes", "threat_closure", "commit_docs"].map((name) => [`phase.${name}`, "off"]), ["phase.branch", "none"]]);
const STATE = ".agents/planning/STATE.md", ROADMAP = ".agents/planning/ROADMAP.md";
const enoent = (path: string) => Object.assign(new Error(`ENOENT: no such file or directory, lstat '${path}'`), { code: "ENOENT" });

/** The phase driver on a fake host whose file store behaves like the real one: a write is compare-and-swap on the file's hash. */
function driver(options: DriverOptions = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const warn = vi.spyOn(bb.log, "warn");
  harness.sdk.stub("threads.send", async () => ({}));
  harness.sdk.stub("threads.get", async (args: { threadId: string }) => ({ status: "idle", projectId: options.projects?.[args.threadId] ?? "projA" }) as never);
  harness.sdk.stub("threads.list", async () => []);
  harness.sdk.stub("threads.stop", async () => ({}));
  harness.sdk.stub("threads.listRunning" as never, async () => []);
  const writes: Array<{ path: string; content: string }> = [];
  const commits: Array<{ paths: string[]; message: string }> = [];
  const hostCalls: string[] = [];
  const reads: string[] = [];
  const texts = new Map<string, string>();
  bb.hosts.experimental_client = (() => ({ call: async (method: string, input: Record<string, unknown>) => {
    hostCalls.push(method);
    if (method === "writePhaseBook") {
      const edits = input.edits as Array<{ path: string; content: string; expectedSha256: string | null }>;
      for (const edit of edits) if ((texts.has(edit.path) ? sha256Hex(texts.get(edit.path)!) : null) !== edit.expectedSha256) return { status: "conflict", writes: [], reason: "expected hash changed" };
      if (options.failWrite) throw new Error("disk full");
      return { status: "applied", writes: edits.map((edit) => { writes.push({ path: edit.path, content: edit.content }); texts.set(edit.path, edit.content); return { path: edit.path, status: "applied", afterSha256: sha256Hex(edit.content) }; }) };
    }
    if (method === "gitCommitDocs") { commits.push({ paths: input.paths as string[], message: input.message as string }); return { commit: "c".repeat(40) }; }
    if (method === "runCommand") return { exitCode: 0, stdout: `${SHA}\n`, stderr: "" };
    if (method === "readBoundedFile") return { path: input.relativePath, content: texts.get(String(input.relativePath)) ?? "file body", truncated: false };
    return {};
  } })) as never;
  const db = openDatabase(bb);
  createRun(db, "run1", "projA", "bb", "/repo");
  db.prepare("UPDATE lane_pilot_run SET writer_host_id='h', writer_workspace_path='/repo', pm_thread_id='t' WHERE id='run1'").run();
  const core = createCore(bb, db);
  core.effectiveProjectSettings = (async () => ({ values: options.settings ?? {} })) as never;
  const services = {
    runBudgets: { get: () => undefined },
    readWriterWorkspaceFile: async (i: { path: string }) => {
      reads.push(i.path);
      if (options.failRead?.includes(i.path)) throw new Error("EIO: i/o error, read");
      if (!texts.has(i.path)) throw enoent(i.path);
      const c = texts.get(i.path)!;
      return { content: c, sha256: sha256Hex(c), sizeBytes: c.length, truncated: false };
    },
    dispatchWriter: async (input: { task: Record<string, unknown> }) => { createTask(db, { id: String(input.task.id), runId: "run1", kind: "bb", contract: input.task }); return { taskId: input.task.id, runId: "run1" }; },
    regression: { run: async () => null }, rollback: { noteStopped: async () => ({ recorded: true }) },
  } as unknown as Services;
  const driverObject = createPhaseDriver(core, services);
  const phases = driverObject.phases;
  const clock = { t: Date.parse("2026-11-01T10:00:00Z") };
  const docs = installDocs({ ctx: core, services: services as never, db, bb, now: () => clock.t, reactions: {} as never });
  return { phases, db, writes, commits, hostCalls, reads, texts, warn, docs, clock, bb };
}
type Driver = ReturnType<typeof driver>;

const openLegacy = (d: Driver, record: Partial<PhaseRecord> = {}, stage: Phase["stage"] = "planning") => {
  insertPhase(d.db, { id: "ph_sma", projectId: "projA", pmThreadId: "t", title: "Sum", goal: "sums", runId: "run1", at: 1 });
  savePhase(d.db, "ph_sma", { stage, record: { context: ctxReady(), ...record }, at: 1 });
  return "ph_sma";
};
const live = (d: Driver, id = "ph_sma") => getPhase(d.db, id)!;
/** The plan an approving checker saw, on the context the phase actually carries. */
const planOn = (p: Phase, items: PlanItem[]) => planRec(items, { contextSha: p.record.context!.sha, sha: planSignature(items, p.record.context!.sha) });
const outside = (text: string) => text.slice(0, text.indexOf(STATE_BLOCK_START)) + text.slice(text.indexOf(STATE_BLOCK_END) + STATE_BLOCK_END.length);

const HAND = "# Project state\r\n\r\n## Decisions\r\n\r\n### Storage\r\n- chose sqlite, do not change\r\n\r\n## Notes\r\nmy own notes\r\n## Decisions of the owner\r\nkeep this";

describe("parity d5-phase-2", () => {
  it("[sma:d_phase_uat] markUatLine marks one numbered line and keeps every other byte, CRLF files included; uat_line rewrites UAT.md only where phase.doc_files is on", async () => {
    const p = phase({ plan: planRec([item("a"), item("b")]), uat: { path: ".agents/phases/ph_sma/UAT.md", sha256: "x", at: 0, lines: [{ n: 1, pieceId: "a", state: "open" }, { n: 2, pieceId: "b", state: "open" }] } });
    const text = uatText(p);
    const marked = markUatLine(text, 2, false, "crashes")!;
    const rows = marked.split("\n"), before = text.split("\n");
    expect(rows.length).toBe(before.length);
    expect(rows.filter((row, i) => row !== before[i])).toHaveLength(1);
    expect(marked).toContain("- [!] 2. b:");
    expect(marked).toContain("— crashes");
    expect(markUatLine(text, 9, true)).toBeNull();
    expect(markUatLine(text, 1, true)).toContain("- [x] 1. a:");
    // CRLF: `.` does not match \r, so a CRLF file used to get nothing written.
    const crlf = "# UAT\r\n- [ ] 1. a: given g\r\n- [ ] 2. b: x\r\n";
    expect(markUatLine(crlf, 1, false, "bad")).toBe("# UAT\r\n- [!] 1. a: given g — bad\r\n- [ ] 2. b: x\r\n");
    expect(markUatLine("- [ ] 1. a: g", 1, true)).toBe("- [x] 1. a: g");

    const uat = { path: ".agents/phases/ph_sma/UAT.md", sha256: "s", at: 0, lines: [{ n: 1, pieceId: "a", state: "open" as const }, { n: 2, pieceId: "b", state: "open" as const }] };
    const on = driver();
    const id = openLegacy(on, { docFiles: true, uat });
    on.texts.set(uat.path, crlf.replace("# UAT\r\n", "# UAT\r\nmy own line\r\n"));
    await on.phases.uatLine({ phaseId: id, line: 1, result: "fail", note: "bad", by: "owner" });
    const written = on.texts.get(uat.path)!;
    expect(written).toBe("# UAT\r\nmy own line\r\n- [!] 1. a: given g — bad\r\n- [ ] 2. b: x\r\n");
    // uat.sha256 (item 10): its only reader tests whether UAT.md was written at all; after the rewrite it is the sha of what is on disk.
    expect(live(on).record.uat?.sha256).toBe(sha256Hex(written));
    expect(on.commits.some((c) => c.message.includes("UAT line 1"))).toBe(true);

    // The default phase: the answer is the record's; no file is touched (as on main).
    const off = driver();
    const id2 = openLegacy(off, { uat });
    off.texts.set(uat.path, crlf);
    await off.phases.uatLine({ phaseId: id2, line: 1, result: "fail", note: "bad", by: "owner" });
    expect(off.writes).toEqual([]);
    expect(off.commits).toEqual([]);
    expect(live(off, id2).record.uat?.lines?.[0]?.state).toBe("failed");
  });

  it("[sma:k_we_animator_inline] the animator's law is main's text; a motion piece carries it with the frequent-action rule only where phase.piece_notes is on", () => {
    const motion = item("m", { promise: { given: "g", when: "w", then: "the card fades in with a 200 ms transition" } });
    const plain = item("t", { promise: { given: "g", when: "w", then: "fix the typo" } });
    expect(motionRows([motion, plain])).toEqual(["m"]);
    expect(ANIMATOR_LAW).not.toContain("many times");
    expect(piecePlan(phase({ pieceNotes: true }), motion)).toContain(`Motion (the animator's law): ${ANIMATOR_LAW}; ${ANIMATOR_FREQUENT_RULE}`);
    expect(piecePlan(phase({ pieceNotes: true }), plain)).not.toContain("Motion (");
    expect(piecePlan(phase({}), motion)).not.toContain("Motion (");
  });

  it("[sma:k_d_tpl_predictions] Predictions, Risk and Motion are in a piece's plan only with phase.piece_notes; a default piece's plan text is main's, so the writer dispatch (findLiveDuplicate compares sha256 of the plan text) matches its live attempt", () => {
    const rich = item("m", { promise: { given: "g", when: "w", then: "the card fades in with a 200 ms transition" },
      task: { ...item("m").task, forecast: { files: 3, checks_pass_first_try: true, tokens: 900 }, risk: "high", never_touch: ["db/**"] } });
    const withContextRisks = phase({ context: { ...ctxReady(), risks: { security: "tokens leak" } } });
    const bare = item("m", { promise: rich.promise, task: item("m").task });
    const defaultText = piecePlan(withContextRisks, rich);
    // This is main's plan text for the piece (git show main:src/rooms/phase/stages.ts, piecePlan): the promise, the contract steps, nothing else.
    expect(defaultText).toBe(piecePlan(phase({}), bare));
    expect(defaultText).not.toMatch(/Risk:|Predictions:|Motion \(|many times in a session/);
    expect(defaultText.split("\n")[0]).toBe("Phase ph_sma «Sum», wave 1, piece m. Promise — given g; when w; then the card fades in with a 200 ms transition.");
    expect(defaultText.split("\n").slice(1, 3)).toEqual(["The phase's plan critic approved this contract; the steps follow it.", "2. Run the checks, red before the work: npm test"]);
    const noted = piecePlan({ ...withContextRisks, record: { ...withContextRisks.record, pieceNotes: true } }, rich);
    expect(noted).toContain("Predictions: files 3, first try, tokens 900");
    expect(noted).toContain("Risk: high; never_touch: db/**; security: tokens leak");
    expect(piecePlan(phase({ pieceNotes: true }), item("n"))).not.toContain("Predictions:");
  });

  it("[sma:k_c_backlog] an item goes under the exact heading `## Backlog` only, as one line; the machine skips only the rows under that heading", () => {
    const roadmap = "# Roadmap\n\n- [ ] 1.2 A — ga\n- [x] 1.1 B\n\n## Backlog\n\n- [ ] 999.2 old — g\n";
    const parked = parkRoadmapRow(roadmap, "new idea", "goal");
    expect(parked.n).toBe("999.3");
    expect(parked.text).toBe("# Roadmap\n\n- [ ] 1.2 A — ga\n- [x] 1.1 B\n\n## Backlog\n\n- [ ] 999.2 old — g\n- [ ] 999.3 new idea — goal\n");
    expect(parkRoadmapRow("# Roadmap\n\n- [ ] 1.1 A — g\n", "x", "").text).toBe("# Roadmap\n\n- [ ] 1.1 A — g\n\n## Backlog\n\n- [ ] 999.1 x\n");
    // Other headings that merely start with «backlog» are not the parking lot: a second, exact heading is made.
    const idea = "# Roadmap\n\n## Backlog ideas\n\n- [ ] 3.1 kept — g\n";
    expect(parkRoadmapRow(idea, "n", "").text).toBe(`${idea}\n## Backlog\n\n- [ ] 999.1 n\n`);
    const top = "# Backlog\n\n- [ ] 4.1 mine\n";
    expect(parkRoadmapRow(top, "n", "").text).toBe(`${top}\n## Backlog\n\n- [ ] 999.1 n\n`);
    // A newline in the name or the goal cannot inject a row or a heading; leading # and - are dropped.
    const hostile = parkRoadmapRow("# R\n\n## Backlog\n\n", "idea\n## Evil\n- [ ] 1.9 y", "- # goal\nsecond");
    expect(hostile.text.split("\n").filter((line) => line.startsWith("## "))).toEqual(["## Backlog"]);
    expect(hostile.text).toContain("- [ ] 999.1 idea ## Evil - [ ] 1.9 y — goal second");
    expect(oneLine("## # title")).toBe("title");
    // CRLF roadmap: the row has the file's line end.
    expect(parkRoadmapRow("# R\r\n\r\n## Backlog\r\n\r\n- [ ] 999.1 a\r\n", "b", "").text).toBe("# R\r\n\r\n## Backlog\r\n\r\n- [ ] 999.1 a\r\n- [ ] 999.2 b\r\n");
    // nextRoadmapRow: a real phase 999.x outside the Backlog heading is advanced to; one under it is not; no heading means main's walk.
    expect(nextRoadmapRow(roadmap)).toMatchObject({ n: "1.2" });
    expect(nextRoadmapRow("# R\n\n## Backlog\n\n- [ ] 999.1 only — g\n")).toBeNull();
    expect(nextRoadmapRow("# R\n\n- [x] 1.1 done\n- [ ] 999.1 a real phase — g\n")).toMatchObject({ n: "999.1" });
    expect(nextRoadmapRow("# R\n\n## Backlog ideas\n\n- [ ] 999.1 not parked — g\n")).toMatchObject({ n: "999.1" });
    // A person's own row under a Backlog heading is not a parked 999.N row: it is still the next phase, as on main.
    expect(nextRoadmapRow("# R\n\n## Backlog\n\n- [ ] 3.1 a person's row — g\n- [ ] 999.1 parked — g\n")).toMatchObject({ n: "3.1" });
    expect(nextRoadmapRow("# R\n\n## Backlog\n\n- [ ] 999.1 parked\n\n## Later\n\n- [ ] 2.1 after the lot — g\n")).toMatchObject({ n: "2.1" });
  });

  describe("[sma:k_c_backlog] the real lp.roadmap_park action on a temporary checkout", () => {
    const PROJECT = "park-project", PM = "park-pm", RUN = "park-run";
    async function parkWorld(initial: string | null, hooks: { afterRead?: (file: string) => void; readError?: string } = {}) {
      const checkout = mkdtempSync(join(tmpdir(), "lp-park-"));
      const file = join(checkout, ROADMAP);
      mkdirSync(join(checkout, ".agents/planning"), { recursive: true });
      if (initial !== null) writeFileSync(file, initial);
      const { bb, harness } = createFakePluginHost({
        pluginId: "lane-pilot",
        experimental_callHostRpc: (async (call: { method: string; input: Record<string, unknown> }) => {
          if (call.method === "readBoundedFile") {
            if (hooks.readError) throw new Error(hooks.readError);
            const read = await readBoundedFile(call.input as never, undefined as never);
            hooks.afterRead?.(file);
            return read;
          }
          if (call.method === "writePhaseBook") return writePhaseBook(call.input as never, undefined as never);
          throw new Error(`unexpected host method ${call.method}`);
        }) as never,
        sdk: {
          threads: { get: async ({ threadId }) => ({ id: threadId, status: "idle", projectId: PROJECT, environmentId: "env-pm" }) },
          environments: { get: async () => ({ id: "env-pm", hostId: "local", path: checkout, status: "ready" }) },
        },
      });
      const db = openDatabase(bb);
      createRun(db, RUN, PROJECT, "bb", checkout, "none", undefined, "local");
      setRunThread(db, RUN, PM);
      const ctx = createCore(bb, db);
      const services = {} as never;
      const engine = new WorkflowEngine({ db, harnessVersion: "test", runtimeFor: chainRuntimeFor(ctx, services) });
      registerPureActions(engine);
      registerReducers(engine);
      registerChainExecutors(engine, ctx, services, createWorkflowAgents());
      const workflow = (await chainStore()).get("backlog-add")!.workflow;
      const run = async (inputs: Record<string, unknown>) => engine.start({ workflow, inputs, runtime: { ctx, services, pmThreadId: PM, projectId: PROJECT, runId: RUN }, link: { projectId: PROJECT, runId: RUN } }).done;
      return { file, run, dispose: () => harness.lifecycle.dispose() };
    }
    const read = (file: string) => readFileSync(file, "utf8");

    it("parks under the next 999.N in the checkout's ROADMAP.md, one line even for a hostile name", async () => {
      const w = await parkWorld("# Roadmap\n\n- [ ] 1.1 A\n\n## Backlog\n\n- [ ] 999.1 old\n");
      const summary = await w.run({ name: "idea\n## Evil\n- [ ] 1.9 y", goal: "# g\n- h" });
      await w.dispose();
      expect(summary.status).toBe("succeeded");
      expect(summary.output).toMatchObject({ status: "done", n: "999.2" });
      expect(read(w.file)).toBe("# Roadmap\n\n- [ ] 1.1 A\n\n## Backlog\n\n- [ ] 999.1 old\n- [ ] 999.2 idea ## Evil - [ ] 1.9 y — g - h\n");
    });

    it("creates the file only when it is absent", async () => {
      const w = await parkWorld(null);
      const summary = await w.run({ name: "first", goal: "" });
      await w.dispose();
      expect(summary.status).toBe("succeeded");
      expect(read(w.file)).toBe("## Backlog\n\n- [ ] 999.1 first\n");
    });

    it("a read that fails for any reason but absence stops the action and writes nothing", async () => {
      const w = await parkWorld("# Roadmap\n\n- [ ] 1.1 A\n", { readError: "EIO: i/o error" });
      const summary = await w.run({ name: "x", goal: "" });
      await w.dispose();
      expect(summary.status).not.toBe("succeeded");
      expect(JSON.stringify(summary)).toContain("could not be read");
      expect(read(w.file)).toBe("# Roadmap\n\n- [ ] 1.1 A\n");
    });

    it("a file changed between the read and the write is refused by the host's hash guard, and the person's line stays", async () => {
      const w = await parkWorld("# Roadmap\n\n- [ ] 1.1 A\n", { afterRead: (file) => writeFileSync(file, "# Roadmap\n\n- [ ] 1.1 A\n- [ ] 7.7 added by a person meanwhile\n") });
      const summary = await w.run({ name: "x", goal: "" });
      await w.dispose();
      expect(summary.status).not.toBe("succeeded");
      expect(read(w.file)).toBe("# Roadmap\n\n- [ ] 1.1 A\n- [ ] 7.7 added by a person meanwhile\n");
    });

    it("writePhaseBook with expectedSha256 null on a file that exists answers conflict and writes nothing", async () => {
      const w = await parkWorld("# mine\n");
      const edits = [{ path: ROADMAP, expectedSha256: null, content: "overwritten" }];
      const root = join(w.file, "..", "..", "..");
      const result = await writePhaseBook({ requestedHostId: "local", projectCwd: root, previewSha256: sha256Hex(JSON.stringify(edits)), edits } as never, undefined as never);
      await w.dispose();
      expect(result.status).toBe("conflict");
      expect(read(w.file)).toBe("# mine\n");
    });
  });

  // ---- k_wv_design (item 1) ----
  const SPEC_PATH = ".agents/phases/ph_x/design/UI-SPEC.md";
  const uiSpec = () => ["# UI-SPEC", "", "## Actions", "- a plain bullet that is prose", "* another bullet", ...Array.from({ length: 47 }, (_, i) => `- [${i % 2 ? "x" : " "}] point ${i + 1}: the screen shows item ${i + 1}`), "", "## Screens", "- more prose", ""].join("\n");

  it("[sma:k_wv_design] only checklist items are points, at most 40, and the cut is counted", () => {
    const found = designPoints(uiSpec());
    expect(found.total).toBe(47);
    expect(found.points).toHaveLength(40);
    expect(found.points.every((point) => point.id.startsWith("design_") && point.text.startsWith("point "))).toBe(true);
    expect(designPoints("- plain\n* plain too\n- [ ] one\n- [x] two\n- [ ] one\n").points.map((point) => point.text)).toEqual(["one", "two"]);
  });

  it("[sma:k_wv_design] points travel the whole way: the workflow's outputs and both emit maps, the PM tool and the RPC", async () => {
    const wf = (await import("../../workflows/lp.close.json")).default as unknown as { outputs: Record<string, string>; nodes: Array<{ id: string; map?: Record<string, unknown>; out?: Record<string, string> }> };
    expect(wf.outputs.points).toBe("PointResult[]");
    expect(wf.nodes.find((node) => node.id === "closed")!.map!.points).toBe("goal_audit.points");
    expect(wf.nodes.find((node) => node.id === "unmet")!.map!.points).toBe("goal_audit.points");
    expect(wf.nodes.find((node) => node.id === "goal_audit")!.out!.points).toBe("PointResult[]");
    const points = [{ id: "design_aaaaaaaa", met: true, evidence: "seen" }, { id: "design_bbbbbbbb", met: false }];
    expect(phaseToolParams.safeParse({ action: "goal_audit", phaseId: "ph_1", state: "met", by: "lp.close", summary: "ok", points }).success).toBe(true);
    expect(phaseToolParams.safeParse({ action: "goal_audit", phaseId: "ph_1", state: "met", by: "lp.close", summary: "ok", points: [{ id: "x", met: true, extra: 1 }] }).success).toBe(false);
    const seen: Array<Record<string, unknown>> = [];
    const rpc = phaseRpc({ goalAudit: (input: Record<string, unknown>) => { seen.push(input); return { id: "ph_1" }; }, status: () => ({}), resolve: () => ({ id: "ph_1" }) } as never) as unknown as Record<string, (input: Record<string, unknown>) => Promise<unknown>>;
    await rpc.phase_act!({ action: "goal_audit", projectId: "projA", phaseId: "ph_1", payload: { state: "met", by: "b", summary: "s", points } });
    expect(seen[0]).toMatchObject({ points });
  });

  it("[sma:k_wv_design] lp.close through the simulator: an audit answer with points reaches the output on the closed and the unmet path, and the phase's acceptance lines hold one line per point", async () => {
    const spec = uiSpec();
    const found = designPoints(spec).points.slice(0, 3);
    const audit = { goals: [{ id: "g1", status: "MET" }], all_met: true, unmet_ids: [], intent_aligned: true, drift_items: [],
      points: [{ id: found[0]!.id, met: true, evidence: "seen on the lobby screen" }, { id: found[1]!.id, met: true }, { id: found[2]!.id, met: false }] };
    const input = { goals: [{ id: "g1", done_when: "flag works", evidence: "npm test" }], boundary: { in_scope: [], out_of_scope: [] }, goal: "g", merged_commits: ["c1"], summary: "s",
      drawing: { paths: [SPEC_PATH], sha256: "s", ui_spec: SPEC_PATH, points: found.map(({ id, text }) => ({ id, text })) } };
    const closed = await runSim("lp.close", { input, stubs: { goal_audit: audit } });
    expect(pathOf(closed)).toBe("goal_audit memory life report closed");
    expect(out(closed)).toMatchObject({ status: "closed", points: audit.points });
    const unmet = await runSim("lp.close", { input, stubs: { goal_audit: { ...audit, all_met: false, unmet_ids: ["g1"] } } });
    expect(out(unmet)).toMatchObject({ status: "unmet", points: audit.points });

    // The sim's output, settled by the real auto-stages into the real goalAudit, on a phase opened with phase.design_points on and on one opened without.
    for (const flagged of [true, false]) {
      const d = driver();
      const id = openLegacy(d, { ...(flagged ? { designPoints: true } : {}), plan: planRec([item("a")]), design: { decision: "needed", why: "x", drawing: { paths: [SPEC_PATH], sha256: "s", designer: "d" } },
        verification: { points: found, verdict: { state: "passed", detail: "ok", mainSha: null, at: 1, inputSha: "i" } } }, "verification");
      const runs = new Map<string, { status: string; output: Record<string, unknown> | null }>();
      const started: unknown[] = [];
      const engine = { resolveWorkflow: (wf: string) => builtinWorkflow(wf),
        start: (request: unknown) => { started.push(request); runs.set("wfrun_1", { status: "running", output: null }); return { runId: "wfrun_1", created: true, done: new Promise(() => undefined) }; },
        get: (runId: string) => ({ runId, reason: null, error: null, failedNode: null, waiting: [], stopped: false, ...runs.get(runId)! }) };
      const auto = createAutoStages({ log: () => undefined }, { workflowEngine: engine as never }, {
        exhausted: async () => undefined, api: { goalAudit: (request: never) => d.phases.goalAudit(request) } as never,
        get: (phaseId: string) => getPhase(d.db, phaseId)!, save: (phaseId: string, record: PhaseRecord) => savePhase(d.db, phaseId, { record, at: 9 }),
        book: () => undefined, writeDocs: async (_p: unknown, files: Array<{ path: string }>) => ({ written: files.map((file) => file.path) }), runtime: () => ({}),
        pmIdle: async () => true, now: () => 1, runStopped: async () => false,
      } as never);
      expect(await auto.step(live(d, id))).toBe(true);
      expect(JSON.stringify(started[0]).includes(found[0]!.id)).toBe(flagged);
      runs.set("wfrun_1", { status: "succeeded", output: out(closed) as Record<string, unknown> });
      expect(await auto.step(live(d, id))).toBe(true);
      const settled = live(d, id);
      const lines = acceptanceLines(settled, new Map([["a", fact("a")]]), { mainSha: null, openDeferrals: 0 });
      if (!flagged) {
        // Main's lines, whatever the audit said and whatever was stored: no design_* line, no verdict kept on a point.
        expect(lines.map((line) => line.id)).toEqual([...ACCEPTANCE_LINES]);
        expect(settled.record.verification?.points?.some((point) => point.met !== undefined)).toBe(false);
      } else {
        const design = lines.filter((line) => line.id.startsWith("design_"));
        expect(design.map((line) => [line.id, line.ok])).toEqual([[found[0]!.id, true], [found[1]!.id, true], [found[2]!.id, false]]);
        expect(design[0]!.detail).toContain("seen on the lobby screen");
        expect(lines.slice(0, ACCEPTANCE_LINES.length).map((line) => line.id)).toEqual([...ACCEPTANCE_LINES]);
      }
    }
  });

  /** The phase candidate's world (tests/phase-candidate.test.ts) with the file store and the tree reader the new steps read. */
  function candWorld(options: { settings?: Record<string, unknown>; treeLines?: Record<string, number>; treeFail?: string[] } = {}) {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    harness.sdk.stub("threads.send", async () => ({}));
    harness.sdk.stub("threads.get", async () => ({ status: "idle", environmentId: "env_pm" }));
    harness.sdk.stub("threads.list", async () => []);
    harness.sdk.stub("environments.get", async () => ({ path: "/repo", hostId: "h" }));
    const head = "1".repeat(40);
    const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
    const files = new Map<string, string>();
    const written: string[] = [];
    bb.hosts.experimental_client = (() => ({ call: async (method: string, input: Record<string, unknown>) => {
      calls.push({ method, input });
      if (method === "runCommand") return { exitCode: 0, stdout: `${head}\n`, stderr: "" };
      if (method === "gitSyncWorktree") return { status: "up-to-date", head, reason: null, conflicts: [] };
      if (method === "gitIntegrate") return { status: "merged", commit: "9".repeat(40), conflicts: [], reason: null, base: head };
      if (method === "writePhaseBook") { for (const edit of (input.edits ?? []) as Array<{ path: string; content: string }>) { files.set(edit.path, edit.content); written.push(edit.path); } return { status: "applied", writes: ((input.edits ?? []) as Array<{ path: string; content: string }>).map((edit) => ({ path: edit.path, status: "applied", afterSha256: sha256Hex(edit.content) })) }; }
      if (method === "readBoundedFile") {
        const path = String(input.relativePath);
        if (String(input.projectCwd).includes("lp-phases")) {
          if (options.treeFail?.includes(path)) throw new Error("EIO: i/o error");
          if (options.treeLines?.[path] === undefined) throw enoent(path);
          return { path, content: "", totalLines: options.treeLines[path], truncated: false };
        }
        throw enoent(path);
      }
      return {};
    } })) as never;
    const db = openDatabase(bb);
    createRun(db, "run1", "projA", "bb", "/repo");
    db.prepare("UPDATE lane_pilot_run SET writer_host_id='h', pm_thread_id='thr_pm' WHERE id='run1'").run();
    const core = createCore(bb, db);
    core.effectiveProjectSettings = (async () => ({ values: options.settings ?? {} })) as never;
    const services = {
      runBudgets: { get: () => undefined },
      dispatchWriter: async (input: { task: Record<string, unknown> }) => { createTask(db, { id: String(input.task.id), runId: "run1", kind: "bb", contract: input.task }); return { taskId: input.task.id, runId: "run1" }; },
      regression: { run: async () => ({ projects: [{ projectId: "projA", head, tasks: [{ taskId: "hud", checks: [{ command: "npm test", state: "green" }] }], findings: [] }] }) },
      runGoal: { check: async () => { throw new Error("the run's goal check reads main, not the candidate"); } },
      readWriterWorkspaceFile: async ({ path }: { path: string }) => { const content = files.get(path); if (content === undefined) throw enoent(path); return { sha256: sha256Hex(content), sizeBytes: content.length, content }; },
    } as unknown as Services;
    const phases = createPhaseDriver(core, services).phases;
    return { phases, db, calls, files, written };
  }
  const hud: PlanItem = { id: "hud", title: "Hud", wave: 1, promise: { given: "g", when: "w", then: "t" },
    task: { id: "hud", project_cwd: "/repo", owns_paths: ["src/**"], verification: [{ command: "npm test", cwd: "/repo/app" }], acceptance: ["the bar stays centred"] } };
  async function atVerification(w: ReturnType<typeof candWorld>, extra: Partial<PhaseRecord>) {
    const opened = await w.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Hud", goal: "hud" });
    const sha = planSignature([hud], "ctx");
    savePhase(w.db, opened.id, { stage: "execution", runId: "run1", record: { ...opened.record, waveReview: false, plan: { items: [hud], contextSha: "ctx", sha, admittedSha: sha }, ...extra } as never, at: 2 });
    await w.phases.drive(w.phases.list({ live: true })[0]!);
    createAttempt(w.db, { id: "att1", runId: "run1", taskId: "hud" });
    w.db.prepare("UPDATE lane_pilot_attempt SET state='accepted' WHERE id='att1'").run();
    for (const stageId of ["verification", "plan-fact", "code-critique"] as const) recordStage(w.db, { runId: "run1", taskId: "hud", stageId, state: "passed", attempt: 1, input: stageId });
    return { id: opened.id, phase: await w.phases.drive(w.phases.list({ live: true })[0]!) };
  }
  const drawn = (w: ReturnType<typeof candWorld>) => {
    const text = uiSpec();
    w.files.set(SPEC_PATH, text);
    return { design: { decision: "needed" as const, why: "screens", drawing: { paths: [SPEC_PATH], sha256: sha256Hex(`${SPEC_PATH}:${sha256Hex(text)}`), designer: "lp.draw" } } };
  };

  it("[sma:k_wv_design] verification reads the points unless phase.design_points is off (unset reads them); an «off» project, and a record opened earlier, store none and keep main's acceptance lines", async () => {
    const on = candWorld({ settings: { "phase.design_points": "on", "phase.doc_files": "on" } });
    const a = await atVerification(on, drawn(on));
    expect(a.phase.stage).toBe("verification");
    expect(a.phase.record.designPoints).toBe(true);
    expect(a.phase.record.verification?.points).toHaveLength(40);
    expect(listParts(on.db, a.id).find((part) => part.kind === "design_points")?.text).toContain("the list was cut: 47 checklist items, the first 40 are kept");
    const linesOn = acceptanceLines(a.phase, on.phases.facts(a.phase), { mainSha: null, openDeferrals: 0 });
    expect(linesOn.filter((line) => line.id.startsWith("design_"))).toHaveLength(40);
    // phase.doc_files: the verdict is stored as VERIFICATION.md with the generated marker; the default run below writes none.
    expect(on.files.get(`.agents/phases/${a.id}/VERIFICATION.md`)).toMatch(new RegExp(`^${GENERATED}\n# Verification`));

    // Unset is the default, on: the same points are read and stored as with the word «on».
    const dflt = candWorld();
    const c = await atVerification(dflt, drawn(dflt));
    expect(c.phase.record.designPoints).toBe(true);
    expect(c.phase.record.verification?.points).toHaveLength(40);
    expect(dflt.files.get(`.agents/phases/${c.id}/VERIFICATION.md`)).toMatch(new RegExp(`^${GENERATED}\n# Verification`));

    const off = candWorld({ settings: PHASE_OFF });
    const b = await atVerification(off, drawn(off));
    expect(b.phase.stage).toBe("verification");
    expect(b.phase.record.designPoints).toBeUndefined();
    expect(b.phase.record.verification?.points).toBeUndefined();
    expect(listParts(off.db, b.id).some((part) => part.kind === "design_points")).toBe(false);
    expect(acceptanceLines(b.phase, off.phases.facts(b.phase), { mainSha: null, openDeferrals: 0 }).map((line) => line.id)).toEqual([...ACCEPTANCE_LINES]);
    // A record that already holds points (written by an earlier build) but was not opened with the switch: still main's lines.
    const earlier = { ...b.phase, record: { ...b.phase.record, verification: { ...b.phase.record.verification!, points: designPoints(uiSpec()).points } } };
    expect(acceptanceLines(earlier, off.phases.facts(b.phase), { mainSha: null, openDeferrals: 0 }).map((line) => line.id)).toEqual([...ACCEPTANCE_LINES]);
    // Neither writes any of the five documents on the way to verification (main writes none there).
    expect(off.written).toEqual([]);
  });

  // ---- item 2: documents in the project ----
  it("[sma:k_wp_commit] a phase with the document switches off writes and commits what main's code does: nothing, through open, context, plan admission and the first wave", async () => {
    const d = driver({ settings: PHASE_OFF });
    d.texts.set(STATE, HAND);
    d.texts.set(ROADMAP, "- [ ] 1.1 A\n");
    d.texts.set(".agents/phases/ph_ctx/CONTEXT.md", "ctx body");
    const items = [item("p1")];
    // Main's list for this drive (open, signed context, admission by the owner's word, the wave issued): no file is written and nothing is committed.
    const first = await d.phases.open({ projectId: "projA", pmThreadId: "t", title: "Sum", goal: "sums", legacy: true });
    savePhase(d.db, first.id, { record: { ...live(d, first.id).record, plan: planOn(live(d, first.id), items), ownerWords: true }, at: 2 });
    await d.phases.word({ phaseId: first.id, turn: "planning", decision: "yes", text: "yes", by: "owner via screen" });
    await d.phases.drive(live(d, first.id));
    await d.phases.stateDone();
    expect(live(d, first.id).stage).toBe("execution");
    const second = await d.phases.open({ projectId: "projA", pmThreadId: "t", title: "Two", goal: "two" });
    savePhase(d.db, second.id, { stage: "discussion", at: 2 });
    d.texts.set(`.agents/phases/${second.id}/CONTEXT.md`, "ctx body");
    await d.phases.context({ phaseId: second.id, docs: [`.agents/phases/${second.id}/CONTEXT.md`], risks: { value: "v", usability: "u", feasibility: "f", viability: "vi" }, appetite: "a", noGos: ["none"], by: "pm" });
    await d.phases.stateDone();
    expect(live(d, second.id).stage).toBe("planning");
    expect(d.writes).toEqual([]);
    expect(d.commits).toEqual([]);
    expect(d.texts.get(STATE)).toBe(HAND);
    // No extra read of the planning files either (each stage move and each wave used to cost two new reads).
    expect(d.reads.filter((path) => path === STATE || path === ROADMAP)).toEqual([]);
    expect(live(d, first.id).record.docShas).toBeUndefined();
  });

  it("[sma:k_wp_commit] with phase.doc_files on (and phase.ambiguity_gate off), SPEC.md and PLAN.md are written with the generated marker and committed; phase.commit_docs off keeps the files and drops only the commits; an absent field commits as main does", async () => {
    const items = [item("p1")];
    for (const commit of ["on", "off", "unset"] as const) {
      const { "phase.commit_docs": _commitOff, ...docsOff } = PHASE_OFF; // commit_docs is on by default: left unset in the «unset» case
      const d = driver({ settings: { ...docsOff, "phase.doc_files": "on", ...(commit === "unset" ? {} : { "phase.commit_docs": commit }) } });
      const opened = await d.phases.open({ projectId: "projA", pmThreadId: "t", title: "Sum", goal: "sums" });
      expect(opened.record.commitDocs).toBe(commit === "off" ? false : undefined);
      savePhase(d.db, opened.id, { stage: "discussion", at: 2 });
      const ctxPath = `.agents/phases/${opened.id}/CONTEXT.md`;
      d.texts.set(ctxPath, "ctx body");
      await d.phases.context({ phaseId: opened.id, docs: [ctxPath], risks: { value: "v", usability: "u", feasibility: "f", viability: "vi" }, appetite: "a", noGos: ["none"], by: "pm" });
      const spec = d.texts.get(`.agents/phases/${opened.id}/SPEC.md`)!;
      expect(spec.startsWith(`${GENERATED}\n# Spec`)).toBe(true);
      expect(spec).not.toContain("Ambiguity:");
      expect(live(d, opened.id).record.docShas?.[`.agents/phases/${opened.id}/SPEC.md`]).toBe(sha256Hex(spec));
      savePhase(d.db, opened.id, { record: { ...live(d, opened.id).record, plan: planOn(live(d, opened.id), items), ownerWords: true }, at: 3 });
      await d.phases.word({ phaseId: opened.id, turn: "planning", decision: "yes", text: "yes", by: "owner via screen" });
      expect(d.texts.get(`.agents/phases/${opened.id}/PLAN.md`)).toContain("then-p1");
      expect(d.commits.some((c) => c.paths.some((p) => p.endsWith("/PLAN.md")))).toBe(commit !== "off");
      expect(d.commits.length > 0).toBe(commit !== "off");
    }
  });

  it("[sma:k_wp_commit] a phase on an install that sets nothing writes SPEC.md with its ambiguity line, PLAN.md and the STATE.md block, and commits them", async () => {
    const d = driver();
    d.texts.set(STATE, HAND);
    const opened = await d.phases.open({ projectId: "projA", pmThreadId: "t", title: "Sum", goal: "sums" });
    expect(opened.record).toMatchObject({ docFiles: true, ambiguityGate: true });
    savePhase(d.db, opened.id, { stage: "discussion", at: 2 });
    const ctxPath = `.agents/phases/${opened.id}/CONTEXT.md`;
    d.texts.set(ctxPath, "ctx body");
    await d.phases.context({ phaseId: opened.id, docs: [ctxPath], risks: { value: "v", usability: "u", feasibility: "f", viability: "vi" }, appetite: "a", noGos: ["none"], by: "pm" });
    const spec = d.texts.get(`.agents/phases/${opened.id}/SPEC.md`)!;
    expect(spec.startsWith(`${GENERATED}\n# Spec`)).toBe(true);
    expect(spec).toContain("Ambiguity: 0");
    savePhase(d.db, opened.id, { record: { ...live(d, opened.id).record, plan: planOn(live(d, opened.id), [item("p1")]), ownerWords: true }, at: 3 });
    await d.phases.word({ phaseId: opened.id, turn: "planning", decision: "yes", text: "yes", by: "owner via screen" });
    await d.phases.stateDone();
    expect(d.texts.get(`.agents/phases/${opened.id}/PLAN.md`)).toContain("then-p1");
    expect(d.commits.some((c) => c.paths.some((p) => p.endsWith("/PLAN.md")))).toBe(true);
    const state = d.texts.get(STATE)!;
    expect(state.startsWith(HAND)).toBe(true);
    expect(state).toContain("<!-- lp:state:start -->");
    expect(live(d, opened.id).record.docShas).toBeDefined();
  });

  it("[sma:k_wp_commit] SPEC.md / PLAN.md / VERIFICATION.md replace only the command's own file: a file it wrote and a person changed keeps its text and the new one goes to <name>.new.md, the book says so; a file it never wrote is left and committed; an unchanged text writes and commits nothing", async () => {
    const d = driver({ settings: { "phase.doc_files": "on" } });
    const id = openLegacy(d, { docFiles: true });
    const path = `.agents/phases/${id}/VERIFICATION.md`;
    await d.docs.writeGenerated(live(d), path, "v1", "m1");
    expect(d.texts.get(path)).toBe(`${GENERATED}\nv1`);
    const count = d.writes.length, commits = d.commits.length;
    await d.docs.writeGenerated(live(d), path, "v1", "m1");
    expect([d.writes.length, d.commits.length]).toEqual([count, commits]);
    await d.docs.writeGenerated(live(d), path, "v2", "m2");
    expect(d.texts.get(path)).toBe(`${GENERATED}\nv2`);
    // A person edits it (the marker survives, the sha no longer matches the record's).
    d.texts.set(path, `${GENERATED}\nv2\nmy remark`);
    await d.docs.writeGenerated(live(d), path, "v3", "m3");
    expect(d.texts.get(path)).toBe(`${GENERATED}\nv2\nmy remark`);
    expect(d.texts.get(path.replace(/\.md$/, ".new.md"))).toBe(`${GENERATED}\nv3`);
    expect(listParts(d.db, id).some((part) => part.text.includes("VERIFICATION.md already exists and was changed by hand") && part.text.includes("VERIFICATION.new.md"))).toBe(true);
    // A .new.md that is not the command's is not overwritten.
    d.texts.set(path.replace(/\.md$/, ".new.md"), "# somebody's file\n");
    await d.docs.writeGenerated(live(d), path, "v4", "m4");
    expect(d.texts.get(path.replace(/\.md$/, ".new.md"))).toBe("# somebody's file\n");
    // A file the command never wrote (the planner's own PLAN.md, a person's SPEC.md) stays as it is, gets no .new.md beside it and is
    // committed: a live phase with doc_files on left a PLAN.new.md beside every planner's PLAN.md.
    const other = `.agents/phases/${id}/SPEC.md`;
    d.texts.set(other, "# my own spec\n");
    const before = d.writes.length;
    await d.docs.writeGenerated(live(d), other, "s1", "spec commit");
    expect(d.texts.get(other)).toBe("# my own spec\n");
    expect(d.texts.has(other.replace(/\.md$/, ".new.md"))).toBe(false);
    expect(d.writes.length).toBe(before);
    expect(d.commits.at(-1)).toEqual({ paths: [other], message: "spec commit" });
    // A failed read writes nothing.
    const broken = driver({ failRead: [path] });
    const id2 = openLegacy(broken, { docFiles: true });
    broken.texts.set(path, "x");
    await broken.docs.writeGenerated(live(broken, id2), path, "y", "m");
    expect(broken.writes).toEqual([]);
    expect(broken.texts.get(path)).toBe("x");
  });

  it("[sma:k_pl_state] [sma:k_lib_statesection] a stage move keeps a hand-written STATE.md byte for byte outside the command's block (own ## Decisions with ### sub-headings, CRLF, no final newline), and a timestamp-only difference writes and commits nothing", async () => {
    const d = driver({ settings: { "phase.doc_files": "on" } });
    d.texts.set(STATE, HAND);
    const first = await d.phases.open({ projectId: "projA", pmThreadId: "t", title: "Sum", goal: "sums", legacy: true });
    await d.phases.stateDone();
    const state = d.texts.get(STATE)!;
    expect(state.startsWith(HAND)).toBe(true);
    expect(outside(state)).toBe(`${HAND}\r\n\r\n`);
    expect(state).toContain("## Decisions (Lane Pilot)");
    expect(state).toContain("- stage planning");
    const block = state.slice(state.indexOf(STATE_BLOCK_START));
    expect(block.replace(/\r\n/g, "")).not.toContain("\n");
    expect(d.commits.at(-1)?.message).toContain("STATE.md at planning");
    // Same state, a minute later: nothing is written, nothing is committed.
    const [w0, c0] = [d.writes.length, d.commits.length];
    d.clock.t += 60_000;
    await d.docs.markState(live(d, first.id));
    expect([d.writes.length, d.commits.length]).toEqual([w0, c0]);
    // A real change rewrites only the block.
    savePhase(d.db, first.id, { stage: "execution", at: 5 });
    await d.docs.markState(live(d, first.id));
    expect(d.writes.length).toBe(w0 + 1);
    const later = d.texts.get(STATE)!;
    expect(later).toContain("- stage execution");
    expect(outside(later)).toBe(`${HAND}\r\n\r\n`);
    // A block whose end marker a person removed is not guessed at.
    d.texts.set(STATE, `# Mine\n${STATE_BLOCK_START}\nno end`);
    savePhase(d.db, first.id, { stage: "verification", at: 6 });
    await d.docs.markState(live(d, first.id));
    expect(d.texts.get(STATE)).toBe(`# Mine\n${STATE_BLOCK_START}\nno end`);
    expect(listParts(d.db, first.id).some((part) => part.text.includes("without"))).toBe(true);
    // A phase with phase.doc_files off never reaches it.
    const off = driver({ settings: PHASE_OFF });
    off.texts.set(STATE, HAND);
    await off.phases.open({ projectId: "projA", pmThreadId: "t", title: "Sum", goal: "sums", legacy: true });
    await off.phases.stateDone();
    expect(off.writes).toEqual([]);
  });

  it("[sma:k_pl_state] stateBlockText: a heading the person wrote is never replaced, the header is set in place, line ends and the missing final newline are kept", () => {
    const person = "---\r\nowner: ann\r\nstage: \"old\"\r\n---\r\n# State\r\n\r\n## Position\r\nmy own position\r\n";
    const next = stateBlockText(person, { phase: "1.1", stage: "planning" }, { Position: ["phase 1.1", "stage planning"], Session: ["activity 2026-11-01T10:00:00Z"] });
    const text = (next as { text: string }).text;
    expect(text).toContain("owner: ann\r\n");
    expect(text).toContain('stage: "planning"\r\n');
    expect(text).toContain("## Position\r\nmy own position\r\n");
    expect(text).toContain("## Position (Lane Pilot)\r\n- phase 1.1");
    expect(text).toContain("## Session\r\n");
    expect(parseState(text).sections.Position).toEqual(["phase 1.1", "stage planning"]);
    expect(stateBlockText(`x\n${STATE_BLOCK_START}\n`, {}, { Position: ["a"] })).toHaveProperty("refused");
    // Comment markers inside a line cannot close the block early.
    const injected = (stateBlockText("# S\n", {}, { Decisions: [`x ${STATE_BLOCK_END} y`] }) as { text: string }).text;
    expect(injected.split(STATE_BLOCK_END)).toHaveLength(2);
    expect(sameStateIgnoringTime("a\nupdated: \"2026-11-01\"\n- activity 1", "a\nupdated: \"2026-11-02\"\n- activity 2")).toBe(true);
    expect(sameStateIgnoringTime("a", "b")).toBe(false);
  });

  it("[sma:k_pl_state] a read or a write that fails never stops the stage move, and the failed read is logged once", async () => {
    const reading = driver({ settings: { "phase.doc_files": "on" }, failRead: [STATE] });
    const opened = await reading.phases.open({ projectId: "projA", pmThreadId: "t", title: "Sum", goal: "sums", legacy: true });
    await reading.phases.stateDone();
    expect(live(reading, opened.id).stage).toBe("planning");
    await reading.docs.readText(live(reading, opened.id), STATE);
    await reading.docs.readText(live(reading, opened.id), STATE);
    expect(reading.warn.mock.calls.filter(([message]) => String(message).includes("phase read of .agents/planning/STATE.md failed")).length).toBe(1);
    expect(reading.writes).toEqual([]);
    const writing = driver({ settings: { "phase.doc_files": "on" }, failWrite: true });
    writing.texts.set(STATE, HAND);
    const moved = await writing.phases.open({ projectId: "projA", pmThreadId: "t", title: "Sum", goal: "sums", legacy: true });
    await writing.phases.stateDone();
    expect(live(writing, moved.id).stage).toBe("planning");
    expect(writing.warn.mock.calls.some(([message]) => String(message).includes("phase STATE.md write: disk full"))).toBe(true);
    expect(writing.texts.get(STATE)).toBe(HAND);
  });

  it("[sma:k_t_state] [sma:k_v_state] `phase state` adds one line to the command's block of a hand-written STATE.md and never drops a person's text; every flag is one line, --set is key=value", async () => {
    const d = driver({ projects: { th_other: "projB", th_mine: "projA" } });
    d.texts.set(STATE, HAND);
    const id = openLegacy(d);
    expect((await d.phases.state({ phaseId: id })).text).toBe(HAND);
    const edited = await d.phases.state({ phaseId: id, decision: "use WAL", blocker: "waits on api" });
    const text = d.texts.get(STATE)!;
    expect(text.startsWith(HAND)).toBe(true);
    expect(outside(text)).toBe(`${HAND}\r\n\r\n`);
    expect(edited.sections["Decisions"]).toEqual(["manual: use WAL"]);
    expect(edited.sections["Blockers"]).toEqual(["manual: waits on api"]);
    await d.phases.state({ phaseId: id, decision: "second" });
    expect(parseState(d.texts.get(STATE)!).sections["Decisions"]).toEqual(["manual: use WAL", "manual: second"]);
    // One line only: a break would write header lines or a heading of its own.
    const before = d.texts.get(STATE);
    for (const bad of [{ set: "a=b\nc=d" }, { set: "a=b\rc" }, { decision: "x\n## Evil" }, { blocker: "x\r\n## Evil" }])
      await expect(d.phases.state({ phaseId: id, ...bad })).rejects.toThrow(/one line/);
    for (const bad of ["nokey", "=v", "bad key=1", "a b"]) await expect(d.phases.state({ phaseId: id, set: bad })).rejects.toThrow(/key=value/);
    await expect(d.phases.state({ phaseId: id, set: "stage=x" })).rejects.toThrow(/front matter/);
    expect(d.texts.get(STATE)).toBe(before);
    // A single line that starts like a heading stays a list item inside the block.
    await d.phases.state({ phaseId: id, decision: "## Evil heading" });
    expect(d.texts.get(STATE)!.split(/\r?\n/).filter((line) => /^##\s+Evil/.test(line))).toEqual([]);
    expect(d.texts.get(STATE)).toContain("- manual: Evil heading");
    // With a front matter the key is set in place and the body stays.
    const headed = driver();
    headed.texts.set(STATE, stateText(null, { phase: "1.1", stage: "execution" }));
    const hid = openLegacy(headed);
    const set = await headed.phases.state({ phaseId: hid, set: "owner=ann" });
    expect(set.marks).toMatchObject({ owner: "ann", phase: "1.1", stage: "execution" });
    expect(headed.texts.get(STATE)).toContain("# State");
    // Nothing invents a STATE.md where no planning files live.
    const bare = driver();
    const bid = openLegacy(bare);
    await expect(bare.phases.state({ phaseId: bid, decision: "x" })).rejects.toThrow(/no planning STATE.md/);
    // Who calls it: a thread (an agent) reaches the phases of its own project only; no thread is the owner at a shell.
    await expect(d.phases.state({ phaseId: id, callerThreadId: "th_other" })).rejects.toThrow(/own project/);
    await expect(d.phases.state({ phaseId: id, decision: "from another project", callerThreadId: "th_other" })).rejects.toThrow(/own project/);
    expect((await d.phases.state({ phaseId: id, callerThreadId: "th_mine" })).text).toContain("manual: use WAL");
    expect(d.texts.get(STATE)).not.toContain("from another project");
  });

  it("[sma:k_t_state] the phase CLI hands the calling thread to the state verb", async () => {
    const { runPhaseCli } = await import("../../src/rooms/phase/server/cli");
    const seen: Array<Record<string, unknown>> = [];
    const api = { state: async (input: Record<string, unknown>) => { seen.push(input); return { text: "t", marks: {}, sections: {} }; } };
    await runPhaseCli(api as never, ["state", "ph_1", "--decision", "x"], "thr_agent");
    await runPhaseCli(api as never, ["state", "ph_1", "--decision", "x"]);
    expect(seen.map((input) => input.callerThreadId)).toEqual(["thr_agent", undefined]);
  });

  it("[sma:k_pl_security] through the verification step: with phase.threat_closure on, citations are read in the tree the verdict judged, past line 2000, and an unreachable file is «not checked», not a gap", async () => {
    const security = (cites: string[]) => ["# Security", "", "## Threats", ...cites.map((cite) => `- a threat — mitigated at ${cite}`), ""].join("\n");
    const secPath = ".agents/phases/ph_x/SECURITY.md";
    const run = async (settings: Record<string, unknown>, cites: string[], tree: { treeLines?: Record<string, number>; treeFail?: string[] }) => {
      const w = candWorld({ settings, ...tree });
      w.files.set(secPath, security(cites));
      const { phase } = await atVerification(w, { context: { docs: [{ path: secPath, sha256: "s", bytes: 1 }], sha: "ctx", signedAt: 1, risks: { security: "tokens could leak" } } });
      return { phase, reads: w.calls.filter((call) => call.method === "readBoundedFile") };
    };
    const tree = { treeLines: { "src/big.ts": 3000, "src/safe.ts": 30 } };
    // Correct citations: the PM checkout has neither file, the candidate's tree has both; line 2500 is past the old 2000-line window.
    const ok = await run({ "phase.threat_closure": "on" }, ["src/big.ts:2500", "src/safe.ts:10"], tree);
    expect(ok.phase.record.verification?.verdict).toMatchObject({ state: "passed" });
    expect(ok.reads.every((call) => String(call.input.projectCwd).includes("lp-phases"))).toBe(true);
    // A line the file does not have, and a file the tree does not have: gaps.
    const gap = await run({ "phase.threat_closure": "on" }, ["src/safe.ts:99", "src/gone.ts:1"], tree);
    expect(gap.phase.record.verification?.verdict).toMatchObject({ state: "failed" });
    expect(gap.phase.record.verification?.verdict?.detail).toContain("src/safe.ts:99, which is not in the code");
    expect(gap.phase.record.verification?.verdict?.detail).toContain("src/gone.ts:1, which is not in the code");
    // A file the reader could not reach: not checked, the verdict keeps its pass and says so.
    const flaky = await run({ "phase.threat_closure": "on" }, ["src/flaky.ts:5", "src/safe.ts:10"], { ...tree, treeFail: ["src/flaky.ts"] });
    expect(flaky.phase.record.verification?.verdict).toMatchObject({ state: "passed" });
    expect(flaky.phase.record.verification?.verdict?.detail).toContain("not checked");
    expect(flaky.phase.record.verification?.verdict?.detail).toContain("src/flaky.ts:5");
    // Off: the verdict is the blind verdict, no citation is read.
    const off = await run({ "phase.threat_closure": "off" }, ["src/gone.ts:1"], tree);
    expect(off.phase.record.threatClosure).toBeUndefined();
    expect(off.phase.record.verification?.verdict).toMatchObject({ state: "passed" });
    expect(off.reads).toEqual([]);
  });

  it("[sma:k_pl_security] threatClosureGaps tells a gap from a row it could not check", () => {
    const doc = "# Threat model\n\n## Threats\n\n- token leak — mitigated by redact: src/secret.ts:42\n- injection — mitigated: src/safe.ts:10\n- flaky — src/flaky.ts:3\n- bare threat\n";
    const found = threatClosureGaps(doc, (path, line) => path === "src/flaky.ts" ? null : path === "src/safe.ts" && line <= 20);
    expect(found.unchecked).toEqual(["src/flaky.ts:3"]);
    expect(found.gaps).toHaveLength(2);
    expect(found.gaps[0]).toContain("src/secret.ts:42");
    expect(found.gaps[1]).toContain("file:line");
    expect(threatClosureGaps(doc.replace("- bare threat\n", ""), () => true)).toEqual({ gaps: [], unchecked: [] });
  });

  it("[sma:k_pl_spec] the ambiguity gate exists only with phase.ambiguity_gate and counts only the open planning questions that hold the plan", () => {
    const q = (id: string, over: Record<string, unknown> = {}) => ({ id, stage: "planning" as const, text: id, blocking: false, askedAt: 0, ...over });
    const gate = (record: PhaseRecord) => planGate(record) as { ok: boolean; why: string[] };
    const approved = { context: ctxReady(), plan: planRec([item("p1")]) };
    // One non-blocking open question with no decision scored 1.0 and stopped an approved plan; a question of another stage did too.
    expect(gate({ ...approved, ambiguityGate: true, questions: [q("q1")] }).ok).toBe(true);
    expect(gate({ ...approved, ambiguityGate: true, questions: [q("q2", { stage: "discussion", blocking: true })] }).ok).toBe(true);
    expect(ambiguityScore({ ...approved, questions: [q("q1"), q("q2", { stage: "discussion", blocking: true })] })).toBe(0);
    // Counted: blocking planning questions, over themselves plus the locked decisions.
    const held = { ...approved, ambiguityGate: true, context: { ...ctxReady(), decisions: ["D1"] }, questions: [q("q3", { blocking: true }), q("q4", { blocking: true })] };
    expect(ambiguityScore(held)).toBe(0.67);
    expect(gate(held).why.some((line) => line.includes("ambiguity is 0.67"))).toBe(true);
    expect(gate({ ...held, questions: [q("q3", { blocking: true, answer: "a" }), q("q4", { blocking: true })] }).why.some((line) => line.includes("ambiguity"))).toBe(false);
    // Unset or absent: planGate is main's, whatever the questions are.
    const plain = gate({ ...held, ambiguityGate: undefined });
    expect(plain.why.some((line) => line.includes("ambiguity"))).toBe(false);
    expect(plain.why.filter((line) => line.startsWith("open question"))).toHaveLength(2);
    expect(nextAction(phase({ ...approved, plan: planRec([item("p1")], { critique: undefined }) }), new Map()).text).not.toContain("ambiguity");
    expect(nextAction(phase({ ...approved, ambiguityGate: true, plan: planRec([item("p1")], { critique: undefined }) }), new Map()).text).toContain("(ambiguity 0)");
    expect(specText(phase({ ...approved, questions: [q("q1", { blocking: true })] }))).not.toContain("Ambiguity:");
    expect(specText(phase({ ...approved, ambiguityGate: true, questions: [q("q1", { blocking: true })] }))).toContain("Ambiguity: 1");
  });

  it("[sma:k_c_import] an abort or a timeout of the owner's resolve ends plan-import with no pieces; the pieces are checked to stay inside the checkout", async () => {
    const stubs = { "grill-plan": { open: ["conflicts with locked decision D3"], risk_register: [] }, pieces: { pieces: [{ id: "p1", task: { owns_paths: ["src/**"] } }], waves: [["p1"]] } };
    for (const kind of ["abort", "timeout"]) {
      const r = await runSim("plan-import", { input: { plan: "step 1", goal: "g" }, stubs, humans: { resolve: { answer_kind: kind, answer: "" } } });
      expect(pathOf(r)).toBe("grill resolve aborted");
      expect(out(r)).toMatchObject({ status: "aborted", pieces: [] });
      expect(r.called("pieces")).toHaveLength(0);
    }
    const bad = await runSim("plan-import", { input: { plan: "step 1", goal: "g" }, stubs: { ...stubs, "lp.plan_import_check": { ok: false, problems: ["p1: owns_paths «../x» is not a path inside the checkout"] } }, humans: { resolve: { answer_kind: "resolved", answer: "keep D3" } } });
    expect(pathOf(bad)).toBe("grill resolve pieces check invalid");
    expect(out(bad)).toMatchObject({ status: "invalid", pieces: [] });
    // The check itself. The plan gate that a later lane_pilot_phase plan call runs (pieceProblems) asks only that some owns_paths exist.
    expect(pieceProblems(item("x", { task: { ...item("x").task, owns_paths: ["../outside", "/etc/**"] } }))).toEqual([]);
    expect(ownsPathProblems("x", ["../outside", "/etc/**", "C:/x", "~/y", "a//b", "a\\b", "src/**", "src/", "docs/a.md", ""])).toHaveLength(7);
    expect(ownsPathProblems("x", ["src/**", "docs/a.md", "src/"])).toEqual([]);
    expect(ownsPathProblems("x", [])).toEqual(["x: no owns_paths"]);
  });

  it("[sma:k_wp_state] issuing wave 2 writes the wave's keys into the header of an existing STATE.md only with phase.doc_files; the body stays", async () => {
    for (const flagged of [true, false]) {
      const d = driver();
      const body = "# State\r\n\r\nbody line\r\n";
      d.texts.set(STATE, `---\r\nphase: "old"\r\nowner: ann\r\n---\r\n${body}`);
      const items = [item("p2", { wave: 2 })];
      const id = openLegacy(d, { ...(flagged ? { docFiles: true } : {}),
        plan: { ...planRec(items), admittedSha: planSignature(items, "ctx"), admittedAt: 0 }, execution: { issued: {}, issuedSha: {} }, waveReview: false, ownerWords: false });
      savePhase(d.db, id, { stage: "execution", at: 1 });
      await d.phases.drive(live(d, id));
      const state = d.texts.get(STATE)!;
      if (!flagged) { expect(state).toBe(`---\r\nphase: "old"\r\nowner: ann\r\n---\r\n${body}`); expect(d.reads).not.toContain(STATE); continue; }
      expect(state).toContain('stage: "execution"\r\n');
      expect(state).toContain('wave: "2"\r\n');
      expect(state).toContain('planned: "true"\r\n');
      expect(state).toContain("owner: ann\r\n");
      expect(state.endsWith(body)).toBe(true);
    }
  });

  it("a phase opened with every switch off carries none of the new record fields; one opened on an install that sets nothing carries each as true; a loose word is not off", async () => {
    const keys = ["designPoints", "docFiles", "ambiguityGate", "pieceNotes", "threatClosure"];
    const plain = await driver({ settings: PHASE_OFF }).phases.open({ projectId: "projA", pmThreadId: "t", title: "Sum", goal: "sums", legacy: true });
    for (const key of [...keys, "docShas"]) expect(plain.record).not.toHaveProperty(key);
    expect(plain.record.commitDocs).toBe(false); // the opt-out of the commits is recorded; its absence is the default, on
    const unset = await driver().phases.open({ projectId: "projA", pmThreadId: "t", title: "Sum", goal: "sums", legacy: true });
    expect(unset.record).toMatchObject(Object.fromEntries(keys.map((key) => [key, true])));
    expect(unset.record).not.toHaveProperty("commitDocs");
    const settings = { "phase.design_points": "on", "phase.doc_files": "on", "phase.ambiguity_gate": "on", "phase.piece_notes": "on", "phase.commit_docs": "off", "phase.threat_closure": "on" };
    const all = await driver({ settings }).phases.open({ projectId: "projA", pmThreadId: "t", title: "Sum", goal: "sums", legacy: true });
    expect(all.record).toMatchObject({ designPoints: true, docFiles: true, ambiguityGate: true, pieceNotes: true, commitDocs: false, threatClosure: true });
    const loose = await driver({ settings: { "phase.design_points": "true", "phase.doc_files": "yes" } }).phases.open({ projectId: "projA", pmThreadId: "t", title: "Sum", goal: "sums", legacy: true });
    expect(loose.record.designPoints).toBe(true);
    expect(loose.record.docFiles).toBe(true);
  });

  it("[sma:k_t_roadmap] roadmapAnalysis flags a ticked row with no SUMMARY.md and a phase folder with no row, and roadmapSection returns only the requested row's block", () => {
    const roadmap = "- [x] 1.1 Done — g\n  - note a\n  - note b\n- [ ] 1.2 Open — g\n- [ ] 2.1 Later — g\n";
    expect(roadmapSection(roadmap, "1.1")).toBe("- [x] 1.1 Done — g\n  - note a\n  - note b");
    expect(roadmapSection(roadmap, "9.9")).toBeNull();
    const a = roadmapAnalysis(roadmap, [
      { id: "ph_a", row: "1.1", hasSummary: false },
      { id: "ph_b", row: "1.2", hasSummary: true },
      { id: "ph_c", hasSummary: false },
    ]);
    expect(a.tickedWithoutSummary[0]).toContain("ph_a");
    expect(a.foldersWithoutRow).toEqual(["ph_c"]);
    expect(a.next?.n).toBe("1.2");
  });

  it("[sma:k_t_template] templateFill PLAN names every piece with its wave and promise, and VERIFICATION marks a piece whose latest fact failed", () => {
    const items = [item("p1"), item("p2", { wave: 2 })];
    const p = phase({ plan: planRec(items) });
    const plan = templateFill("PLAN", p, new Map());
    expect(plan).toContain("Wave 2");
    expect(plan).toContain("then-p2");
    expect(planText(p)).toContain("p1");
    const ver = templateFill("VERIFICATION", p, new Map([["p1", fact("p1")], ["p2", fact("p2", { verification: "failed" })]]));
    expect(ver).toContain("p2 (failed)");
    expect(ver).toContain("`npm test`");
  });

  it("[sma:k_ag_animator] the animator session text says an action the person repeats often gets no animation; the rule reaches a piece only through phase.piece_notes", () => {
    for (const words of ["typing", "row hover", "list moves"]) expect(ANIMATOR_FREQUENT_RULE).toContain(words);
    expect(ANIMATOR_FREQUENT_RULE).toContain("not animated");
    const overlay = laneSessionOverlayPrompt("animator")!;
    expect(overlay).toContain("performs many times in a session");
    expect(overlay).toContain("not animated");
  });
});

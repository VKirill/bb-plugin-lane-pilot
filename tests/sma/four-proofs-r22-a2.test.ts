// Region 22 · The project planning folder, batch a (part 2): REVIEW.md, the backlog, the hand-off card, the lesson into hub memory, the project
// settings, the owner profile on the hub and the three audit graphs (docs/sma-evidence.md). Each test checks what was written or returned.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@lane-pilot/kit";
import { createRun, openDatabase } from "../../src/rooms/plugin-db";
import { loadProjectSettings, saveProjectSetting } from "../../src/rooms/storage";
import { backlogBoard, type TodoMeta } from "../../src/rooms/backlog/logic";
import { createHandoff, getHandoff, HANDOFF_DEFAULT_DEADLINE_MS } from "../../packages/handoff/src/store";
import { reviewDoc } from "../../src/rooms/phase/stages";
import { createCore } from "../../src/rooms/core/server/core";
import { savePhase } from "../../src/rooms/phase/store";
import { createPhaseDriver } from "../phase-driver";
import { hostContract } from "../../src/rooms/core/server/plugin-contracts";
import { anamnesisHandler } from "../../src/rooms/anamnesis/host";
import { createHub } from "../../src/rooms/anamnesis/hub";
import { openStore } from "../../src/rooms/anamnesis/store";
import { extractMessages } from "../../src/rooms/anamnesis/extract";
import { fragmentJudgeVia, parseFragments, type FragmentDecision } from "../../src/rooms/anamnesis/fragments";
import type { OwnerMessage } from "../../src/rooms/anamnesis/owner-messages";
import { runSim } from "../workflow/chain-harness";
import { out, pathOf } from "../workflow/chain-helpers";

const clip = (value: unknown, max: number) => String(typeof value === "string" ? value : value === undefined || value === null ? "" : JSON.stringify(value)).trim().slice(0, max);

describe("[region 22] REVIEW.md", () => {
  it("[sma:k_pl_review] each wave has its own section with status, counts, reviewer and findings; a later pass over one wave replaces only that section", () => {
    const wave1 = reviewDoc("ph_a1", null, 1, false, { status: "rework", critical_count: 1, high_count: 0, findings: [{ file: "src/a.ts", line: 12, title: "save() result ignored" }, { text: "no test for empty cell" }] }, "code-critic", clip);
    expect(wave1.split("\n")).toEqual(["# Review — phase ph_a1", "", "## Wave 1 — failed", "", "status rework; critical 1, high 0; reviewer code-critic", "",
      "- src/a.ts:12 save() result ignored", "- no test for empty cell", ""]);
    const both = reviewDoc("ph_a1", wave1, 2, true, { status: "pass", findings: [] }, "code-critic", clip);
    expect(both).toContain("## Wave 1 — failed");
    expect(both.split("\n").slice(-6)).toEqual(["## Wave 2 — passed", "", "status pass; critical 0, high 0; reviewer code-critic", "", "- no findings", ""]);
    expect(both.split("\n").filter((line) => line.startsWith("## "))).toEqual(["## Wave 1 — failed", "## Wave 2 — passed"]);
    expect(both.split("\n")).toContain("- no findings");
    // Wave 1 reviewed again after the fix: its section is replaced, wave 2's stays.
    const redone = reviewDoc("ph_a1", both, 1, true, { status: "pass", findings: [] }, "code-critic", clip);
    expect(redone.split("\n").filter((line) => line.startsWith("## "))).toEqual(["## Wave 2 — passed", "## Wave 1 — passed"]);
    expect(redone).not.toContain("save() result ignored");
  });
});

describe("[region 22] the backlog", () => {
  const todo = (id: string, over: Partial<TodoMeta> = {}): TodoMeta => ({ id, title: id, status: "ready", priority: "medium", estimate: 3, dependsOn: [], created: "2026-11-01", ...over });

  it("[sma:k_pl_todos] ready items are sorted into issuable (urgency, then size, then age), needs-estimate, above 13 to decompose, and blocked by an unfinished dependency", () => {
    const board = backlogBoard([
      todo("late-small", { priority: "low", estimate: 1 }), todo("urgent-big", { priority: "high", estimate: 8 }), todo("urgent-small", { priority: "high", estimate: 2 }),
      todo("no-estimate", { estimate: null }), todo("huge", { estimate: 21 }), todo("waits", { dependsOn: ["open-one"] }), todo("open-one", { status: "open" }),
      todo("after-done", { dependsOn: ["finished"], estimate: 5 }), todo("finished", { status: "done" }), todo("idea", { status: "open", estimate: 1 }),
    ]);
    expect(board.issuable.map((item) => item.id)).toEqual(["urgent-small", "urgent-big", "after-done", "late-small"]);
    expect(board.needsEstimate.map((item) => item.id)).toEqual(["no-estimate"]);
    expect(board.decompose.map((item) => item.id)).toEqual(["huge"]);
    expect(board.blocked.map((item) => item.id)).toEqual(["waits"]);
    // A dependency list needs every item done: one done and one open is still blocked.
    expect(backlogBoard([todo("a", { dependsOn: ["x", "y"] }), todo("x", { status: "done" }), todo("y", { status: "ready" })]).blocked.map((item) => item.id)).toEqual(["a"]);
  });
});

describe("[region 22] the hand-off card is a row on the hub", () => {
  it("[sma:k_pl_handoff] a card is stored queued with its sender, recipient and acceptance, gets the 48 hour default deadline and a first event", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const draft = { fromAgent: "pm", toAgent: "writer", title: "Finish the sums", objective: "continue where the session stopped", acceptance: ["the sums skip empty cells"], inputs: [{ kind: "path" as const, ref: ".agents/phases/ph_a1/PLAN.md" }], budget: {}, deadlineAt: null };
    const card = createHandoff(db as never, { id: "hf_1", projectId: "projA", runId: "run1", ownerThreadId: "thr_pm", draft, now: 1_000_000 });
    expect(card.card).toMatchObject({ id: "hf_1", projectId: "projA", runId: "run1", fromAgent: "pm", toAgent: "writer", state: "queued", recipientThreadId: null, deadlineAt: 1_000_000 + 48 * 3_600_000 });
    expect(HANDOFF_DEFAULT_DEADLINE_MS).toBe(48 * 3_600_000);
    expect(getHandoff(db as never, "hf_1")?.card.acceptance).toEqual(["the sums skip empty cells"]);
    const own = createHandoff(db as never, { id: "hf_2", projectId: "projA", draft: { ...draft, deadlineAt: 5_000_000 }, now: 1_000_000 });
    expect(own.card.deadlineAt).toBe(5_000_000);
    const events = db.prepare("SELECT handoff_id, to_state AS to_state FROM lane_pilot_handoff_event WHERE handoff_id=?").all("hf_1") as Array<{ to_state?: string }>;
    expect(events).toHaveLength(1);
    expect(events[0]!.to_state).toBe("queued");
  });
});

describe("[region 22] project settings", () => {
  it("[sma:k_pl_config] the project's settings are the global ones, then the project's own, then the run's binding: later layers win, values come back parsed", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const set = (project: string, key: string, value: unknown, binding = "") => db.prepare("INSERT OR REPLACE INTO lane_pilot_project_settings(project_id,binding_id,key,value,version,updated_at) VALUES (?,?,?,?,1,1)").run(project, binding, key, typeof value === "string" ? value : JSON.stringify(value));
    saveProjectSetting(db, "projA", "phase.branch", "milestone");
    saveProjectSetting(db, "projA", "run.max_tokens", 5000);
    saveProjectSetting(db, "projA", "owner.words", false);
    set("projB", "phase.branch", "phase");
    const own = loadProjectSettings(db, "projA");
    expect(own["phase.branch"]).toBe("milestone");
    expect(own["run.max_tokens"]).toBe(5000);
    expect(own["owner.words"]).toBe(false);
    expect(loadProjectSettings(db, "projB")["phase.branch"]).toBe("phase");
    expect(loadProjectSettings(db, "projB")["run.max_tokens"]).toBeUndefined();
    // A binding (a run scope) overrides the project's own value for that key only.
    set("projA", "phase.branch", "run-scoped", "scope1");
    const scoped = loadProjectSettings(db, "projA", ["scope1"]);
    expect(scoped["phase.branch"]).toBe("run-scoped");
    expect(scoped["run.max_tokens"]).toBe(5000);
    expect(loadProjectSettings(db, "projA")["phase.branch"]).toBe("milestone");
    expect(loadProjectSettings(db, "projNone")).toEqual({});
  });
});

describe("[region 22] the phase's lesson goes to project memory on the hub, not to a file", () => {
  const before = process.env.LANE_PILOT_OWNER_WORDS_DEFAULT;
  afterEach(() => { if (before === undefined) delete process.env.LANE_PILOT_OWNER_WORDS_DEFAULT; else process.env.LANE_PILOT_OWNER_WORDS_DEFAULT = before; });

  it("[sma:k_pl_learnings] closing a phase at lessons stores the analysis as a note of the project in the memory door (a hub row), and the phase closes; the lesson is not kept as a file", async () => {
    process.env.LANE_PILOT_OWNER_WORDS_DEFAULT = "off";
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    harness.sdk.stub("threads.send" as never, async () => ({}));
    harness.sdk.stub("threads.get" as never, async () => ({ status: "idle" }));
    const db = openDatabase(bb);
    createRun(db, "run1", "projA");
    db.prepare("UPDATE lane_pilot_run SET pm_thread_id=? WHERE id=?").run("thr_pm", "run1");
    const services = { runBudgets: { get: () => undefined }, readWriterWorkspaceFile: async ({ path }: { path: string }) => ({ sha256: sha256Hex(path), sizeBytes: 120, content: `# ${path}` }) };
    const { phases } = createPhaseDriver(createCore(bb, db), services as never);
    const phase = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Sums", goal: "sums skip empty cells" });
    const id = phase.id;
    savePhase(db, id, { stage: "lessons", record: { ...phases.status(id).phase.record, lessons: { needed: true, why: "a return" } }, at: 2 });
    const analysis = "The plan missed the empty-cell case; a check per promise would have caught it.";
    const input = JSON.stringify({ with: {}, via: { mode: "artifact", fromStep: "retro#1", fromThreadId: "thr_retro", handoff: analysis } });
    db.prepare("INSERT INTO lane_pilot_wf_run(id,workflow_id,workflow_version,workflow_sha256,definition_json,project_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run("wf_read", "retrospective", 1, "sha", "{}", "projA", "succeeded", 1, 1);
    db.prepare("INSERT INTO lane_pilot_wf_step(run_id,step_key,origin,node_id,visit,state,input_json,receipt_json,started_at,ended_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run("wf_read", "stage#1", "stage#1", "stage", 1, "succeeded", input, JSON.stringify({ executor: "agent", inputSha256: sha256Hex(input), threadId: "thr_stage" }), 1, 2, 2);
    const memory = () => db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_memory_fts WHERE project_id='projA'").get() as { n: number };
    expect(memory().n).toBe(0);
    const closed = phases.lessons({ phaseId: id, analysis, reviewRun: "wf_read" });
    expect(closed.stage).toBe("closed");
    expect(memory().n).toBe(1);
    const row = db.prepare("SELECT content FROM lane_pilot_memory_fts WHERE project_id='projA'").get() as { content: string };
    expect(row.content).toContain("check per promise");
  });
});

describe("[region 22] the owner's profile lives in the hub store", () => {
  const DAY = 86_400_000, NOW = Date.UTC(2026, 9, 8, 10);
  let kv: Map<string, unknown>;
  const previousDir = process.env.LANE_PILOT_ANAMNESIS_DIR;
  beforeEach(() => { process.env.LANE_PILOT_ANAMNESIS_DIR = join(mkdtempSync(join(tmpdir(), "r22-anamnesis-")), "store"); kv = new Map(); });
  afterEach(() => { if (previousDir === undefined) delete process.env.LANE_PILOT_ANAMNESIS_DIR; else process.env.LANE_PILOT_ANAMNESIS_DIR = previousDir; });
  const message = (n: number, text: string): OwnerMessage => ({ id: `thr_1:${n}:0`, threadId: "thr_1", projectId: "proj_bb", at: NOW - DAY, text });
  const reply = (...fragments: Array<Record<string, unknown>>) => JSON.stringify({ fragments });

  it("[sma:k_pl_userprofile] a fragment the reader calls lasting and about the owner becomes a kind; a task request, a low-confidence guess or an unreadable reply stays nothing", async () => {
    const decisions = parseFragments(reply(
      { id: "f1", kind: "preference", about_owner: true, sensitive: false, confidence: "high" },
      { id: "f2", kind: "nothing", about_owner: false, sensitive: false, confidence: "high" },
      { id: "f3", kind: "skill", about_owner: true, sensitive: false, confidence: "low" },
      { id: "f4", kind: "fact", about_owner: false, sensitive: false, confidence: "high" },
      { id: "f5", kind: "self", about_owner: true, sensitive: true, confidence: "medium" },
    ), 6);
    expect(decisions[0]).toEqual({ kind: "preference", kindP: 0.9, aboutOwner: 0.9, sensitive: 0 });
    expect(decisions[1]).toMatchObject({ kind: "nothing" });
    expect(decisions[2]).toMatchObject({ kind: "nothing", kindP: 0.3 });
    expect(decisions[3]).toMatchObject({ kind: "nothing", aboutOwner: 0 });
    expect(decisions[4]).toEqual({ kind: "self", kindP: 0.6, aboutOwner: 0.6, sensitive: 0.9 });
    expect(decisions[5]).toBeNull();
    expect(parseFragments("not json", 2)).toEqual([null, null]);
    expect(await fragmentJudgeVia(async () => { throw new Error("model down"); })(["a", "b"])).toEqual([null, null]);
  });

  it("[sma:k_pl_userprofile] a lasting message of the owner is stored as a record in the hub's anamnesis store, a task message is not", async () => {
    const hub = createHub({
      hostCall: async (hostId, request) => hostContract.anamnesis.output.parse(await anamnesisHandler(hostContract.anamnesis.input.parse({ requestedHostId: hostId, request }))).response,
      listHosts: async () => [{ id: "host_mini", name: "MAC Mini", connected: true }],
      kv: { get: async <T>(key: string) => kv.get(key) as T | undefined, set: async (key, value) => { kv.set(key, value); } },
      store: openStore(":memory:"),
    });
    const judge = async (texts: string[]) => texts.map((text): FragmentDecision => text.includes("всегда") ? { kind: "preference", kindP: 0.9, aboutOwner: 0.9, sensitive: 0 } : { kind: "nothing", kindP: 0.9, aboutOwner: 0.1, sensitive: 0 });
    const report = await extractMessages({ hub, now: () => NOW, judge }, [message(1, "всегда пиши отчёты по-русски, коротко и без воды, это моя привычка"), message(2, "проверь сборку на сервере и скажи, что упало в последнем запуске")]);
    expect(report).toMatchObject({ considered: 2, asked: 2, kept: 1, created: 1, complete: true });
    const stored = (await hub.ask({ op: "list", includeSensitive: true })).records;
    expect(stored).toHaveLength(1);
    expect(["candidate", "draft"]).toContain(stored[0]!.status);
    expect(stored[0]!.statement).toContain("отчёты по-русски");
  });
});

describe("[region 22] the audit graphs report where their document is", () => {
  it("[sma:k_pl_uireview] the six pillars review is written by its own node and its path is reported; with review_file off the node is skipped", async () => {
    const stubs = { capture: { status: "pass", screenshots: ["a.png"] }, audit: { score_40: 30, score_20: 14, findings: [], report_path: "audit.md" } };
    const on = await runSim("ui-audit", { input: { url: "http://localhost:4173" }, stubs: { ...stubs, review_doc: { review_path: ".agents/ui/pricing/UI-REVIEW.md" } } });
    expect(on.called("review_doc")).toHaveLength(1);
    expect(on.skipped).not.toContain("review_doc");
    expect(on.path).toContain("review_doc");
    const off = await runSim("ui-audit", { input: { url: "http://localhost:4173", review_file: false }, stubs });
    expect(off.skipped).toContain("review_doc");
    expect(off.called("review_doc")).toHaveLength(0);
  });

  it("[sma:k_pl_evalreview] a flawed evaluation is reported with the EVAL-REVIEW.md path and a todo is offered; a sound one is reported sound with no offer", async () => {
    const flawed = await runSim("eval-review", { input: { phase_id: "ph_a" }, stubs: { review: { findings: [{ file: "AI-SPEC.md", line: 3, severity: "high", evidence: "no eval for the empty reply", dimension: "coverage" }], review_path: ".agents/phases/ph_a/EVAL-REVIEW.md", flawed: true } } });
    expect(out(flawed)).toMatchObject({ status: "flawed", review_path: ".agents/phases/ph_a/EVAL-REVIEW.md", proposed_workflow: "todo-add" });
    expect(pathOf(flawed)).toBe("review offer flawed");
    const sound = await runSim("eval-review", { input: { phase_id: "ph_a" }, stubs: { review: { findings: [], review_path: ".agents/phases/ph_a/EVAL-REVIEW.md", flawed: false } } });
    expect(out(sound)).toMatchObject({ status: "sound", review_path: ".agents/phases/ph_a/EVAL-REVIEW.md" });
    expect((out(sound) as Record<string, unknown>).proposed_workflow).toBeUndefined();
  });

  it("[sma:k_pl_aispec] the AI-SPEC is checked up to twice: a pass ends done with the spec path; a spec the checker refuses twice ends blocked, still naming the path", async () => {
    const base = { select: { framework: "langchain", options: [] }, research: { notes: "ok" }, spec: { spec_path: ".agents/phases/ph_a/AI-SPEC.md" } };
    const ok = await runSim("ai-integration-phase", { input: { goal: "rank photos" }, stubs: { ...base, check: { ok: true, gaps: [] } } });
    expect(out(ok)).toMatchObject({ status: "done", framework: "langchain", spec_path: ".agents/phases/ph_a/AI-SPEC.md" });
    const once = await runSim("ai-integration-phase", { input: { goal: "rank photos" }, stubs: { ...base, check: [{ ok: false, gaps: ["no guardrails"] }, { ok: true, gaps: [] }] } });
    expect(out(once)).toMatchObject({ status: "done" });
    expect(once.called("spec")).toHaveLength(2);
    const twice = await runSim("ai-integration-phase", { input: { goal: "rank photos" }, stubs: { ...base, check: { ok: false, gaps: ["no guardrails"] } } });
    expect(out(twice)).toMatchObject({ status: "blocked", framework: "langchain", spec_path: ".agents/phases/ph_a/AI-SPEC.md" });
  });
});

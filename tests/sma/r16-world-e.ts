// Region 16 (slash commands and workflows), batch e: the plan check and admission, the review / audit / QA workflows and the live check (n1268 … n1297).
// The scratch world the node tests and the scene probe (scripts/lp_drill/scenes/sma_r16_e_probe.ts) share. Each `observeE.<smaId>()` runs the REAL code of the node (the plan
// gate and the auto stage on plain records, the phase driver on a scratch database and a fake host, the real workflow engine with fake executors on the real graph files,
// the host handlers of the live check against a local server and a stand-in runner) and returns plain data. No vitest import: the probe loads this file under vite-node.
// No model, no hub, nothing outside the machine. Batches a to d keep their observations in r16-world*.ts (not edited here).
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { sha256Hex } from "@lane-pilot/kit";
import { createCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../server";
import { createPhaseDriver } from "../phase-driver";
import { createRun, createTask, openDatabase, saveProjectSetting } from "../../src/rooms/plugin-db";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planGate, planSignature, type Phase, type PhaseRecord, type PlanItem } from "../../src/rooms/phase/logic";
import { autoDue, createAutoStages } from "../../src/rooms/phase/server/auto-stages";
import { coverageGaps, planText } from "../../src/rooms/phase/stages";
import { PLAN_ROUNDS_MAX } from "../../src/rooms/phase/stages";
import { getPhase, listParts, savePhase } from "../../src/rooms/phase/store";
import { runSim } from "../workflow/chain-harness";
import { item, phase, PH } from "./r16-world";
import { observeB } from "./r16-world-b";

type Row = Record<string, unknown>;
const ctxReady = () => ({ docs: [], sha: "ctx", signedAt: 1, legacy: true });
const planRec = (items: PlanItem[], over: Record<string, unknown> = {}) => ({ items, contextSha: "ctx", sha: planSignature(items, "ctx"), critique: { decision: "approve", by: "c", independence: { ok: true, why: "" } }, objective: "o", premortem: ["a", "b", "c"], ...over });
const why = (record: PhaseRecord): string[] => { const check = planGate(record); return check.ok ? [] : check.why; };
const planningRecord = (over: Record<string, unknown> = {}, planOver: Record<string, unknown> = {}, items: PlanItem[] = [item("p1")]) =>
  ({ context: ctxReady(), plan: planRec(items, planOver), ...over }) as unknown as PhaseRecord;
const pathOf = (r: Awaited<ReturnType<typeof runSim>>) => r.path.join(" ");
const outOf = (r: Awaited<ReturnType<typeof runSim>>) => r.summary.output as Row;
const ranOf = (r: Awaited<ReturnType<typeof runSim>>) => r.path.filter((id) => !r.skipped.includes(id)).join(" ");

/** The phase driver on a fake host whose file store is a map: an absent file reads as absent (ENOENT), a written one as written; every commit is recorded. */
function phaseWorld() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.send", async () => ({}));
  harness.sdk.stub("threads.get", async () => ({ status: "idle", environmentId: "env_pm" }));
  harness.sdk.stub("environments.get", async () => ({ path: "/repo", hostId: "h" }));
  harness.sdk.stub("threads.list", async () => []);
  harness.sdk.stub("threads.stop", async () => ({}));
  harness.sdk.stub("threads.listRunning" as never, async () => []);
  const texts = new Map<string, string>();
  const commits: Array<{ paths: string[]; message: string }> = [];
  bb.hosts.experimental_client = (() => ({ call: async (method: string, input: Record<string, unknown>) => {
    if (method === "writePhaseBook") {
      const edits = input.edits as Array<{ path: string; content: string }>;
      return { status: "applied", writes: edits.map((edit) => { texts.set(edit.path, edit.content); return { path: edit.path, status: "applied", afterSha256: sha256Hex(edit.content) }; }) };
    }
    if (method === "gitCommitDocs") { commits.push({ paths: input.paths as string[], message: String(input.message) }); return { commit: "c".repeat(40) }; }
    if (method === "runCommand") return { exitCode: 0, stdout: `${"a".repeat(64)}\n`, stderr: "" };
    if (method === "readBoundedFile") return { path: input.relativePath, content: texts.get(String(input.relativePath)) ?? "file body", truncated: false };
    return {};
  } })) as never;
  const db = openDatabase(bb);
  createRun(db, "run1", "projA", "bb", "/repo");
  db.prepare("UPDATE lane_pilot_run SET writer_host_id='h', writer_workspace_path='/repo', pm_thread_id='thr_pm' WHERE id='run1'").run();
  const services = {
    runBudgets: { get: () => undefined },
    readWriterWorkspaceFile: async (i: { path: string }) => { if (!texts.has(i.path)) throw new Error("ENOENT: no such file"); const c = texts.get(i.path)!; return { content: c, sha256: sha256Hex(c), sizeBytes: c.length }; },
    dispatchWriter: async (input: { task: Record<string, unknown> }) => { createTask(db, { id: String(input.task.id), runId: "run1", kind: "bb", contract: input.task as never }); return { taskId: input.task.id, runId: "run1" }; },
    regression: { run: async () => null }, rollback: { noteStopped: async () => ({ recorded: true }) },
  } as unknown as Services;
  const phases = createPhaseDriver(createCore(bb, db), services).phases;
  return { phases, db, texts, commits };
}

/** The auto stage's `apply` on a plain phase object: what it saved, what it booked, what it wrote. */
async function applyAuto(p: Phase, auto: Row, output: Row) {
  const saved: PhaseRecord[] = [], booked: string[] = [], written: Array<{ path: string; content: string }> = [], texts = new Map<string, string>();
  const stages = createAutoStages({ log: () => undefined } as never, { workflowEngine: {} } as never, {
    api: {} as never, exhausted: async () => undefined, get: () => p,
    save: (_id: string, record: PhaseRecord) => { saved.push(record); },
    book: (_p: unknown, _s: string, kind: string, text: string) => { booked.push(`${kind}:${text}`); },
    writeDocs: async (_p: unknown, files: Array<{ path: string; content: string }>) => { files.forEach((file) => { texts.set(file.path, file.content); written.push(file); }); return { written: files.map((file) => file.path) }; },
    readText: async (_p: unknown, path: string) => texts.get(path) ?? null,
    runtime: () => null, pmIdle: async () => true, now: () => 10,
  } as never);
  await stages.apply(p, auto as never, output);
  return { saved, booked, written };
}

export const observeE = {
  // ---- phase planning
  /** n1268: no plan runs without an independent check: the gate names a missing check, a check that asked for changes and a check that is not proven independent. */
  k_wp_checker() {
    return {
      approved: why(planningRecord()),
      noCheck: why(planningRecord({}, { critique: undefined })),
      changes: why(planningRecord({}, { critique: { decision: "changes_requested", by: "c", summary: "split p1" } })),
      notIndependent: why(planningRecord({}, { critique: { decision: "approve", by: "c", independence: { ok: false, why: "same thread" } } })),
      noRun: why(planningRecord({}, { critique: { decision: "approve", by: "c" } })),
    };
  },
  /** n1269: three rounds of «changes» at most: the machine plans again after rounds 1 and 2, the gate stops the phase after the third. */
  k_wp_revision() {
    const at = (rounds: number, decision = "changes_requested") => planningRecord({}, { rounds, critique: { decision, by: "c" } });
    const due = (rounds: number) => autoDue(phase(at(rounds), "planning"))?.kind ?? null;
    return { max: PLAN_ROUNDS_MAX, due: [due(0), due(1), due(2), due(3)], gate2: why(at(2)), gate3: why(at(3)), gate3approved: why(planningRecord({}, { rounds: 3 })) };
  },
  /** n1270: the external bounce runs once per plan sha, only where the project asks for it, and only after the plan checker approved. */
  async k_wp_bounce() {
    const base = (over: Record<string, unknown> = {}, planOver: Record<string, unknown> = {}) => phase({ ...planningRecord({}, planOver), ...over } as never, "planning");
    const sha = planRec([item("p1")]).sha;
    const asked = base({ planBounce: true });
    const changes = await applyAuto(asked, { kind: "bounce", wfRunId: "w1", startedAt: 1 }, { status: "changes_requested", findings: [{ text: "narrow p1" }], rounds: 2 });
    const approve = await applyAuto(asked, { kind: "bounce", wfRunId: "w1", startedAt: 1 }, { status: "approve", rounds: 1 });
    const again = await applyAuto(base({ planBounce: true }, { bounce: { sha, decision: "approve", at: 1 } }), { kind: "bounce", wfRunId: "w1", startedAt: 1 }, { status: "changes_requested" });
    return {
      due: autoDue(asked)?.kind ?? null,
      off: autoDue(base())?.kind ?? null,
      done: autoDue(base({ planBounce: true }, { bounce: { sha, decision: "approve", at: 1 } }))?.kind ?? null,
      otherSha: autoDue(base({ planBounce: true }, { bounce: { sha: "old", decision: "approve", at: 1 } }))?.kind ?? null,
      unchecked: autoDue(base({ planBounce: true }, { critique: undefined }))?.kind ?? null,
      changes: { bounce: changes.saved[0]?.plan?.bounce, gaps: String(changes.saved[0]?.replan?.gaps ?? "").slice(0, 60), booked: changes.booked[0]?.slice(0, 40) },
      approve: { decision: approve.saved[0]?.plan?.bounce?.decision, replan: approve.saved[0]?.replan ?? null },
      again: again.saved.length,
    };
  },
  /** n1271: every requirement of the signed context needs a piece that covers it. */
  k_wp_reqgate() {
    const rec = (covers: string[], context: Row = { requirements: ["R1", "R2"] }) => ({ ...planningRecord({}, {}, [item("p1", { covers })]), context: { ...ctxReady(), ...context } }) as unknown as PhaseRecord;
    const alreadyMet = { ...rec([]), plan: { ...planRec([]), alreadyMet: { evidence: "e" } } } as unknown as PhaseRecord;
    return { open: coverageGaps(rec(["R1"])), all: coverageGaps(rec(["R1", "R2"])), none: coverageGaps(rec([])), noContext: coverageGaps(rec([], {})), gate: why(rec(["R1"])), gateAll: why(rec(["R1", "R2"])), alreadyMet: why(alreadyMet) };
  },
  /** n1272: every locked decision of the signed context needs a piece that carries it out. */
  k_wp_decgate() {
    const rec = (covers: string[], context: Row = { decisions: ["D1", "D2"] }) => ({ ...planningRecord({}, {}, [item("p1", { covers })]), context: { ...ctxReady(), ...context } }) as unknown as PhaseRecord;
    return { open: coverageGaps(rec(["D2"])), all: coverageGaps(rec(["D1", "D2"])), none: coverageGaps(rec([])), both: coverageGaps(rec(["R1"], { requirements: ["R1", "R2"], decisions: ["D1"] })), gate: why(rec(["D1"])), gateAll: why(rec(["D1", "D2"])) };
  },
  /** n1273: a closed phase marks its row in the roadmap and its phase and stage in STATE.md, once (the same paperwork pass as n1195, read for the marks). */
  async k_wp_state() {
    const seen = await observeB.k_c_transition();
    const roadmap = await observeB.k_we_roadmap();
    return { stateHas: seen.stateHas, rows: roadmap.rows, parked: roadmap.parked, unknown: roadmap.unknown, closed: seen.closed };
  },
  /** n1274: the admitted plan is committed as PLAN.md where the project keeps phase documents, one section per wave, and nowhere else. */
  async k_wp_commit() {
    const items = [item("p1"), item("p2", { wave: 2 })];
    const run = async (record: Record<string, unknown>) => {
      const w = phaseWorld();
      saveProjectSetting(w.db, "projA", "phase.plan_bounce", "off");
      const made = await w.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Hud", goal: "hud" });
      savePhase(w.db, made.id, { stage: "planning", state: "active", runId: "run1", record: { ...made.record, context: ctxReady(), plan: planRec(items), ...record } as never, at: 2 });
      await w.phases.drive(getPhase(w.db, made.id)!);
      const plan = w.texts.get(`.agents/phases/${made.id}/PLAN.md`);
      return { stage: getPhase(w.db, made.id)!.stage, plan: plan?.split("\n").map((line) => line.replace(made.id, "<id>")) ?? null, commits: w.commits.map((c) => c.paths.map((path) => path.replace(made.id, "<id>")).filter((path) => path.endsWith("PLAN.md"))).filter((paths) => paths.length) };
    };
    return { on: await run({ docFiles: true }), off: await run({ docFiles: false }), noCommit: await run({ docFiles: true, commitDocs: false }) };
  },
  /** n1275: the machine moves an admitted plan on to execution by itself (a drawing first only when the plan needs one); a plan that the gate refuses stays at planning. */
  async k_wp_advance() {
    const run = async (items: PlanItem[], over: Record<string, unknown> = {}, planOver: Record<string, unknown> = {}) => {
      const w = phaseWorld();
      saveProjectSetting(w.db, "projA", "phase.plan_bounce", "off");
      const made = await w.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Hud", goal: "hud" });
      savePhase(w.db, made.id, { stage: "planning", state: "active", runId: "run1", record: { ...made.record, context: ctxReady(), plan: planRec(items, planOver), ...over } as never, at: 2 });
      await w.phases.drive(getPhase(w.db, made.id)!);
      const after = getPhase(w.db, made.id)!;
      return { stage: after.stage, admitted: !!after.record.plan?.admittedSha, design: after.record.design?.decision ?? null, booked: listParts(w.db, made.id).filter((part) => part.section === "plan").map((part) => part.kind) };
    };
    const screen = item("ui1", { task: { ...item("ui1").task, owns_paths: ["src/app.tsx"], qa_cases: [{ name: "c" }], qa_url: "http://x" } });
    return { plain: await run([item("p1")]), screens: await run([screen]), refused: await run([item("p1")], {}, { critique: { decision: "changes_requested", by: "c" } }), unsigned: await run([item("p1")], {}, { objective: "" }) };
  },

  // ---- review, security, audit
  /** n1276: /sma-code-review reviews the change, writes the report, and offers the fix workflow only when the review asks for rework. */
  async k_c_codereview() {
    const finding = { severity: "high", file: "src/search.ts", line: 22, evidence: "await missing" };
    const rework = await runSim("code-review", { input: { range: "main..feature/search" }, stubs: { "lp.review": { status: "rework", findings: [finding], high_count: 1 } } });
    const pass = await runSim("code-review", { input: { range: "main..feature/search" }, stubs: { "lp.review": { status: "pass", findings: [], warn: true } } });
    return {
      rework: { path: pathOf(rework), out: { status: outOf(rework).status, proposed: outOf(rework).proposed_workflow, high: outOf(rework).high_count, findings: outOf(rework).findings } },
      pass: { path: pathOf(pass), out: { status: outOf(pass).status, proposed: outOf(pass).proposed_workflow ?? null, warn: outOf(pass).warn } },
    };
  },
  /** n1277: code-review-fix: findings in, plan and build the fixes, review again; a second round when the review still asks for rework, then a classified rest for the owner. */
  async k_c_crfix() {
    const findings = [{ file: "src/a.ts", line: 12, severity: "high", evidence: "return value of save() ignored" }];
    const stubs = (review: unknown) => ({ "lp.plan": { status: "ok", task_count: 1, tasks: [{ id: "f1", objective: "f1", depends_on: [] }] }, "lp.build": { status: "done", merged_commits: ["f1"] }, "lp.review": review as never, classify: { remaining: [{ file: "src/a.ts" }] }, ask: { answer: "ok", answer_kind: "accept" } });
    const one = await runSim("review-fix", { input: { goal: "Fix", findings }, stubs: stubs({ status: "pass", remaining_actionable: 0 }) });
    const two = await runSim("review-fix", { input: { goal: "Fix", findings }, stubs: stubs([{ status: "rework", remaining_actionable: 1 }, { status: "pass", remaining_actionable: 0 }]) });
    const spent = await runSim("review-fix", { input: { goal: "Fix", findings }, stubs: stubs({ status: "rework", remaining_actionable: 1 }) });
    const noBuild = await runSim("review-fix", { input: { goal: "Fix", findings }, stubs: { ...stubs({ status: "pass" }), "lp.build": { status: "failed", merged_commits: [] } } });
    const pick = (r: Awaited<ReturnType<typeof runSim>>) => ({ path: ranOf(r), status: (r.summary.output as Row | null)?.status ?? r.summary.status });
    return { one: pick(one), two: pick(two), spent: { ...pick(spent), plans: spent.called("plan_fix").length + spent.called("plan_fix2").length, builds: spent.called("build_fix").length + spent.called("build_fix2").length, reviews: spent.called("re_review").length }, noBuild: pick(noBuild), partialRemaining: outOf(spent).remaining };
  },
  /** n1278: /sma-secure-phase ends in gaps naming the open threats, or in done when every threat is closed and the goal check holds. */
  async k_c_secure() {
    const path = ".agents/phases/ph_a/SECURITY.md";
    const open = await runSim("secure-phase", { input: { phase_id: "ph_a" }, stubs: { audit: { open: ["T1", "T2"], security_path: path } } });
    const clean = await runSim("secure-phase", { input: { phase_id: "ph_a" }, stubs: { audit: { open: [], security_path: path } } });
    const unmet = await runSim("secure-phase", { input: { phase_id: "ph_a" }, stubs: { audit: { open: [], security_path: path }, goal_check: { ok: false, verdict: "fail", reason: "no table" } } });
    return { open: [pathOf(open), outOf(open)], clean: [pathOf(clean), outOf(clean)], unmet: [pathOf(unmet), outOf(unmet).status] };
  },
  /** n1279: /sma-validate-phase ends in gaps naming the promises without a real check, or in done. */
  async k_c_validate() {
    const path = ".agents/phases/ph_a/VALIDATION.md";
    const gaps = await runSim("validate-phase", { input: { phase_id: "ph_a" }, stubs: { audit: { gaps: ["p2: existence-only check"], validation_path: path, sampled: 3 } } });
    const clean = await runSim("validate-phase", { input: { phase_id: "ph_a" }, stubs: { audit: { gaps: [], validation_path: path, sampled: 3 } } });
    const unmet = await runSim("validate-phase", { input: { phase_id: "ph_a" }, stubs: { audit: { gaps: [], validation_path: path, sampled: 3 }, goal_check: { ok: false, verdict: "fail", reason: "x" } } });
    return { gaps: [pathOf(gaps), outOf(gaps)], clean: [pathOf(clean), outOf(clean)], unmet: [pathOf(unmet), outOf(unmet).status] };
  },
  /** n1280: /sma-ui-review: capture at the listed viewports, score from the evidence, write the review file unless switched off, offer the fix workflow on a low score, blocked when nothing could be captured. */
  async k_c_uireview() {
    const stubs = (audit: Row, capture: Row = { status: "pass", screenshots: ["s375.png", "s1280.png"] }) => ({ capture, audit: { score_40: 30, score_20: 14, findings: [], report_path: "r.md", ...audit }, review_doc: { review_path: ".agents/ui/pricing/UI-REVIEW.md" } });
    const input = { url: "http://localhost:4173/pricing" };
    const ok = await runSim("ui-audit", { input, stubs: stubs({}) });
    const noFile = await runSim("ui-audit", { input: { ...input, review_file: false }, stubs: stubs({}) });
    const low = await runSim("ui-audit", { input, stubs: stubs({ score_40: 20 }) });
    const zero = await runSim("ui-audit", { input, stubs: stubs({ score_40: 0 }) });
    const blocked = await runSim("ui-audit", { input, stubs: stubs({}, { status: "block", screenshots: [] }) });
    return { ok: [ranOf(ok), outOf(ok).status, outOf(ok).score_40, outOf(ok).screenshots], noFile: ranOf(noFile), low: [ranOf(low), outOf(low).proposed_workflow], zero: ranOf(zero), blocked: [ranOf(blocked), outOf(blocked).status] };
  },
  /** n1281: /sma-eval-review: a flawed evaluation is reported flawed and a todo is offered; a sound one ends sound with no offer. */
  async k_c_evalreview() {
    const base = { findings: [] as unknown[], review_path: "x/EVAL-REVIEW.md" };
    const sound = await runSim("eval-review", { input: { phase_id: "ph_1" }, stubs: { review: { ...base, flawed: false } } });
    const flawed = await runSim("eval-review", { input: { phase_id: "ph_1" }, stubs: { review: { ...base, findings: [{ severity: "high", evidence: "no gold set" }], flawed: true } } });
    const unmet = await runSim("eval-review", { input: { phase_id: "ph_1" }, stubs: { review: { ...base, flawed: false }, goal_check: { ok: false, verdict: "fail", reason: "x" } } });
    return { sound: [pathOf(sound), outOf(sound).status, outOf(sound).proposed_workflow ?? null], flawed: [pathOf(flawed), outOf(flawed).status, outOf(flawed).proposed_workflow, (outOf(flawed).findings as unknown[]).length], unmet: [pathOf(unmet), outOf(unmet).status] };
  },
  /** n1282: /sma-audit-uat reads the open and failed acceptance lines of every phase from its UAT.md, writes UAT-AUDIT.md and offers a follow-up only when asked and something is open. */
  async k_c_audituat() {
    const stubs = (count: number) => ({ audit: { open_count: count, document: "# UAT audit" } });
    const asked = await runSim("audit-uat", { input: { propose_followup: true }, stubs: stubs(2) });
    const nothing = await runSim("audit-uat", { input: { propose_followup: true }, stubs: stubs(0) });
    const plain = await runSim("audit-uat", { input: {}, stubs: stubs(2) });
    const w = phaseWorld();
    const lines: Record<string, string> = { a: "- [ ] 1. p1: line open\n- [!] 2. p2: line failed\n", b: "- [x] 1. p1: done\n" };
    const ids: string[] = [];
    for (const name of ["a", "b"]) {
      const made = await w.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: name, goal: name });
      const path = `.agents/phases/${made.id}/UAT.md`;
      savePhase(w.db, made.id, { stage: "acceptance", state: "active", runId: "run1", record: { ...made.record, uat: { path, sha256: "s", at: 1 } } as never, at: 2 });
      w.texts.set(path, lines[name]!);
      ids.push(made.id);
    }
    const rows = (await w.phases.uatOpen({ projectId: "projA" })).filter((row) => ids.includes(row.phaseId));
    return {
      asked: [pathOf(asked), outOf(asked).open_count], nothing: pathOf(nothing), plain: pathOf(plain),
      rows: rows.map((row) => `${ids.indexOf(row.phaseId) === 0 ? "a" : "b"}:${row.state}`),
    };
  },
};
void PH; void listParts; void planText; void chmodSync; void mkdirSync; void mkdtempSync; void readFileSync; void writeFileSync; void createServer; void tmpdir; void join; void ranOf; void pathOf; void outOf;
export type { AddressInfo };

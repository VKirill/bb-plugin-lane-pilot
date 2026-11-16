// Region 16 (slash commands and workflows), batch g: the milestone close and summary, new milestone, cleanup, ship (gate, preflight, review, PR, hooks), deploy, project start, code
// analysis — n1330 … n1348. The scratch world the node tests and the scene probe (scripts/lp_drill/scenes/sma_r16_g_probe.ts) share. Each `observeG.<smaId>()` runs the REAL
// code of the node (the real workflow engine on the real graph file with the model steps answering from a table, the real full-gate verdict) and returns plain data. No vitest
// import: the probe loads this file under vite-node. No model, no hub, nothing outside the machine. Batches a–d's observations are in r16-world*.ts (not edited here).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fullGateVerdict, FULL_GATE_VALID_MS } from "../../src/rooms/storage/gate-runs-store";
import { runSim } from "../workflow/chain-harness";

type Row = Record<string, unknown>;
type Sim = Awaited<ReturnType<typeof runSim>>;
const wfJson = (name: string) => JSON.parse(readFileSync(join(process.cwd(), "workflows", `${name}.json`), "utf8")) as { inputs: Record<string, { default?: unknown }>; nodes: Array<Row & { id: string }> };
const nodeOf = (name: string, id: string) => wfJson(name).nodes.find((row) => row.id === id)!;
const promptOf = (name: string, id: string) => String(nodeOf(name, id).prompt ?? "");
const out = (sim: Sim) => sim.summary.output as Row;
const ran = (sim: Sim) => sim.path.filter((id) => !sim.skipped.includes(id));
const at = (list: string[], id: string) => list.indexOf(id);

// ---------------------------------------------------------------- milestone close
const CLEAR = { open_tasks: 0, failed_tasks: 0, unmerged: 0, gate_ok: true, running_attempts: 0, merged_commits: ["abc"], gate_state: "green", unmerged_seen: 0, uncovered_reqs: [] as string[],
  retro_living: "on", milestone_archive: "on", milestone_summary: "on", coverage_matrix: "REQ-1: ph_a" };
const CLOSE_STUBS = { "lp.close": { status: "closed", staged: 2, report_path: "reports/close.md" }, retro: { insights: [], retro_path: ".agents/retro/r1.md", metrics: {} },
  "milestone-summary": { summary_path: ".agents/planning/MILESTONE-SUMMARY.md" }, record: { record_path: ".agents/milestones/run-1.md" },
  snapshot: { folder: ".agents/planning/milestones/stats-1", files: ["ROADMAP.md", "REQUIREMENTS.md"], kept: false }, living: { updated: 1, total: 1, path: ".agents/retro/LIVING.md" } };
const INPUT = { run_id: "run-1", goal: "Stats export", goals: [{ id: "g1", done_when: "d", evidence: "e" }] };
const closeRun = (status: Row, humans: Record<string, Row> = {}, stubs: Row = {}) => runSim("milestone-close", { input: INPUT,
  stubs: { ...CLOSE_STUBS, "lp.run_status": { ...CLEAR, ...status }, ...stubs } as never, humans: { approve_knowledge: { answer_kind: "approved", approved_ids: ["c1"] }, ...humans } });

async function k_c_completems() {
  const on = await closeRun({});
  const off = await closeRun({ retro_living: "off", milestone_archive: "off", milestone_summary: "off" });
  const record = nodeOf("milestone-close", "record") as unknown as { params: Row; reads: string[] };
  const snapshot = nodeOf("milestone-close", "snapshot") as unknown as { params: Row };
  return { onPath: ran(on), offPath: ran(off), onOut: out(on), offOut: out(off), recordPath: record.params.path, recordReads: record.reads, snapshotName: snapshot.params.name,
    retroPrompt: promptOf("milestone-close", "retro"), onSnapshotCalled: on.called("snapshot").length, offSnapshotCalled: off.called("snapshot").length, onRecordCalled: on.called("record").length, offRecordCalled: off.called("record").length };
}

async function k_c_mssummary() {
  const alone = await runSim("milestone-summary", { input: { milestone: "Stats export" }, stubs: { summary: { section: "## Stats export\n", open_items: ["docs"] }, write_summary: { summary_path: ".agents/planning/MILESTONE-SUMMARY.md" } } });
  const on = await closeRun({});
  const off = await closeRun({ milestone_summary: "off" });
  const halted = await closeRun({}, {}, { "lp.close": { status: "unmet", staged: 0, report_path: "r.md" } });
  const prompt = promptOf("milestone-summary", "summary");
  return { alonePath: alone.path, aloneOut: out(alone), onPath: ran(on), offPath: ran(off), haltedPath: ran(halted), haltedStatus: out(halted).status, summaryCalls: [on, off, halted].map((sim) => sim.called("summary").length),
    sources: /ROADMAP\.md.*STATE\.md.*SUMMARY\.md.*UAT\.md.*REVIEW\.md/s.test(prompt), keepsEarlier: /keep every earlier section as it is; never overwrite/.test(prompt) };
}

async function k_c_auditms() {
  const asked = async (status: Row, answer: Row = { answer_kind: "finish_first" }) => {
    const sim = await closeRun(status, { ask_finish: answer });
    return { asked: sim.called("ask_finish").length, status: out(sim).status, uncovered: out(sim).uncovered_requirements, gate: out(sim).gate_state, unmergedSeen: out(sim).unmerged_seen, path: ran(sim) };
  };
  return { clear: await asked({}), open: await asked({ open_tasks: 2 }), uncovered: await asked({ uncovered_reqs: ["REQ-2"], coverage_matrix: "REQ-1: ph_a\nREQ-2: —" }), red: await asked({ gate_state: "red" }),
    unlanded: await asked({ unmerged_seen: 1 }), running: await asked({ running_attempts: 1 }), anyway: await asked({ uncovered_reqs: ["REQ-2"] }, { answer_kind: "close_anyway" }),
    timeout: await asked({ open_tasks: 1 }, { answer_kind: "timeout" }), prompt: promptOf("milestone-close", "ask_finish") };
}

// ---------------------------------------------------------------- new milestone and cleanup
async function newMilestone(goal: string) {
  return runSim("new-milestone", { input: { goal }, stubs: { archive: { folder: ".agents/planning/milestones/v1-1", files: ["ROADMAP.md"], kept: false }, frame: { phases: ["1 coverage of REQ-2", "2 the gate"] } } });
}
async function k_c_msgaps() {
  const sim = await newMilestone("close the audit gaps: REQ-2 has no phase");
  return { path: sim.path, out: out(sim), framePrompt: promptOf("new-milestone", "frame"), frameGoal: sim.called("frame").length };
}
async function k_c_newmilestone() {
  const sim = await newMilestone("v2 billing");
  return { path: sim.path, out: out(sim), archiveFirst: at(sim.path, "archive") < at(sim.path, "frame"), archiveCalls: sim.called("archive").length, frameCalls: sim.called("frame").length,
    framePrompt: promptOf("new-milestone", "frame"), entry: (wfJson("new-milestone") as unknown as { entry: string }).entry };
}
async function k_c_cleanup() {
  const run = (plan: Row, goal: Row = {}) => runSim("cleanup", { input: {}, stubs: { plan, goal_check: { ok: true, verdict: "pass", reason: "", details: {}, ...goal } } });
  const dry = await run({ moved: ["phases/ph_old"], applied: false });
  const applied = await run({ moved: ["phases/ph_old"], applied: true });
  const failed = await run({ moved: ["phases/ph_old"], applied: true }, { ok: false, verdict: "fail" });
  return { dryRun: wfJson("cleanup").inputs.dry_run?.default, dry: { path: dry.path, out: out(dry) }, applied: { path: applied.path, out: out(applied) }, failed: { path: failed.path, out: out(failed) }, prompt: promptOf("cleanup", "plan") };
}

// ---------------------------------------------------------------- ship
const SHIP_STUBS = { gate: { ok: true, failing: [] as string[] }, preflight: { ready: true, held_by: [] as string[] }, review_range: { range: "main..HEAD" }, open_pr: { pr_url: "https://git.example/pr/7" }, "lp.post_ship_hooks": { count: 0, files: [] as string[] } };
const ship = (stubs: Row = {}, input: Row = {}) => runSim("ship", { input: { phase_id: "ph_a", ...input }, stubs: { ...SHIP_STUBS, ...stubs } as never });
const shipView = (sim: Sim) => ({ path: ran(sim), skipped: sim.skipped, out: out(sim), preflightCalls: sim.called("preflight").length, prCalls: sim.called("open_pr").length, reviewCalls: sim.called("review").length });

async function k_ws_preflight() {
  const ready = await ship();
  const held = await ship({ preflight: { ready: false, held_by: ["verification is not passed: acceptance line 2 does not hold"] } });
  return { ready: shipView(ready), held: shipView(held), prompt: promptOf("ship", "preflight") };
}
async function k_ws_fullgate() {
  const now = 1_800_000_000_000, head = "a".repeat(40), other = "b".repeat(40);
  const row = (state: string, rowHead: string, ageMs: number, reason = "") => ({ id: 1, projectId: "p", runId: "r", scopeKey: "s", command: "npm test", batch: [], state, head: rowHead, reason, startedAt: now - ageMs, updatedAt: now - ageMs }) as never;
  const verdict = (state: string, rowHead: string, ageMs: number, shipHead: string | null) => fullGateVerdict(row(state, rowHead, ageMs), shipHead, now);
  const blocked = await ship({ gate: { ok: false, failing: ["the gate's green mark is older than six hours (on aaaaaaaaaaaa)"] } });
  return { windowHours: FULL_GATE_VALID_MS / 3_600_000, none: fullGateVerdict(undefined, head, now), fresh: verdict("passed", head, 10 * 60_000, head), stale: verdict("passed", head, 7 * 3_600_000, head),
    edge: verdict("passed", head, 5 * 3_600_000 + 59 * 60_000, head), wrongHead: verdict("passed", other, 60_000, head), unknownHead: verdict("passed", other, 60_000, null), red: verdict("failed", head, 60_000, head), running: verdict("running", head, 60_000, head), blocked: shipView(blocked) };
}
async function k_ws_vendor() {
  const missing = "untriaged vendor update: lodash 4.17.21 → 5.0.0 has no note";
  const held = await ship({ preflight: { ready: false, held_by: ["verification is not passed", missing] } });
  const clean = await ship();
  return { heldBy: out(held).held_by, status: out(held).status, prCalls: held.called("open_pr").length, path: ran(held), cleanHeldBy: out(clean).held_by, prompt: promptOf("ship", "preflight") };
}
async function k_ws_infra() {
  const base = { preflight: { clean: true, pushed: true, head: "h1", running_attempts: 0, gate_ok: true, last_version: "0.1.182" }, tests: { ok: true, tests_passed: 3, tests_failed: 0, no_tests: false }, post_check: { ok: true, details: "", expected: "v2", seen: "v2" }, record: { staged: 1 } };
  const steps = "rsync -a dist/ deploy@host:/srv/app";
  const other = await runSim("deploy", { input: { target: "ssh", environment: "staging", deploy_steps: steps, accounts: ["ssh-prod"] }, stubs: { ...base, run_deploy: { ok: true, version: "v2", log_path: "log", backup_path: "bk" } } as never });
  const plugin = await runSim("deploy", { input: { target: "lane-pilot-plugin", environment: "staging" }, stubs: { ...base, push_plugin: { ok: true, version: "0.1.183", log_path: "plog" } } as never });
  const prod = await runSim("deploy", { input: { target: "script", environment: "prod", deploy_steps: steps }, stubs: { ...base, run_deploy: { ok: true, version: "v3", log_path: "l", backup_path: "b" } } as never, humans: { approve: { answer_kind: "deploy" } } });
  const refused = await runSim("deploy", { input: { target: "ssh", environment: "prod", deploy_steps: steps }, stubs: base as never, humans: { approve: { answer_kind: "abort" } } });
  const run = nodeOf("deploy", "run_deploy") as unknown as { prompt: string; role: string; authorized: boolean };
  return { other: { path: ran(other), out: out(other), plugin: other.called("push_plugin").length }, plugin: { path: ran(plugin), out: out(plugin), errand: plugin.called("run_deploy").length }, prod: { path: ran(prod), out: out(prod) },
    refused: { path: ran(refused), status: out(refused).status, deploys: refused.called("run_deploy").length }, errandRole: run.role, errandAuthorized: run.authorized, readsSteps: /Do exactly `deploy_steps` for `ref`/.test(run.prompt), inputs: Object.keys(wfJson("deploy").inputs) };
}
async function k_ws_push() {
  const shipped = await ship();
  const gateHold = await ship({ gate: { ok: false, failing: ["no gate run"] } });
  const preHold = await ship({ preflight: { ready: false, held_by: ["x"] } });
  const reviewHold = await ship({ "code-review": { status: "rework" } }, { review: true });
  const prompt = promptOf("ship", "open_pr");
  return { shippedPr: shipped.called("open_pr").length, shippedOut: out(shipped), holds: [gateHold, preHold, reviewHold].map((sim) => ({ pr: sim.called("open_pr").length, status: out(sim).status })), prompt,
    pushBeforePr: prompt.indexOf("git push -u origin HEAD") >= 0 && prompt.indexOf("git push -u origin HEAD") < prompt.indexOf("gh pr create"), role: nodeOf("ship", "open_pr").role };
}
async function k_ws_pr() {
  const shipped = await ship();
  const prompt = promptOf("ship", "open_pr");
  return { prUrl: out(shipped).pr_url, status: out(shipped).status, prompt, consumes: nodeOf("ship", "open_pr").consumes };
}
async function k_ws_review() {
  const stub = (status: string) => ({ "code-review": { status } });
  const review = async (status: string | null) => shipView(await ship(status ? stub(status) : {}, { review: status !== null, base: "main" }));
  const sim = await ship(stub("pass"), { review: true, base: "main" });
  return { off: await review(null), pass: await review("pass"), rework: await review("rework"), block: await review("block"), range: sim.called("review")[0]?.input };
}
async function k_ws_track() {
  const shipped = await ship();
  const prompt = promptOf("ship", "open_pr");
  return { status: out(shipped).status, hooksFailed: out(shipped).hooks_failed, prompt, path: ran(shipped) };
}
async function k_ws_post() {
  const none = await ship();
  const some = await ship({ "lp.post_ship_hooks": { count: 2, files: ["a", "b"] }, post_ship: { hooks_run: ["h1"], hooks_failed: ["h2"] } });
  const prompt = promptOf("ship", "post_ship");
  return { none: { path: ran(none), calls: none.called("post_ship").length, failed: out(none).hooks_failed, status: out(none).status }, some: { path: ran(some), calls: some.called("post_ship").length, failed: out(some).hooks_failed, status: out(some).status },
    renders: /lane-plan render-hooks post-ship/.test(prompt), notUndone: /does not undo the ship/.test(prompt) };
}

// ---------------------------------------------------------------- project start
const START_STUBS = { tree: { enabled: "on", sources: 3, tests: 2, docs: 1, planning: 0, commits: 9, counts_note: "n", profile_note: "p", recap_note: "r" }, probe: { has_passport: false, open_tasks: 0, plan_exists: false, has_ui: false, has_value_map: false, has_roadmap: false, has_profile: false },
  value_map: { document: "v" }, preview: { stack: {}, memory: {}, profile: { stack: "ts" } }, profile_write: { refused: [], set: ["stack"], reasons: [] }, research: { research_notes: "r" }, requirements: { requirements: ["REQ-1"], document: "# req\n" }, recap: { next_steps: ["a", "b", "c"], roadmap_draft: "# roadmap\n", project_document: "# project\n", phases: ["1 first"] } };
const start = (stubs: Row = {}, humans: Row = {}, mode?: "quick" | "standard" | "full") => runSim("project-start", { input: { goal: "g" }, stubs: { ...START_STUBS, ...stubs } as never, humans: { ask: { answer_kind: "answered" }, ...humans } as never, ...(mode ? { mode } : {}) });
async function k_c_start() {
  const first = await start();
  const resumed = await start({ probe: { ...START_STUBS.probe, has_value_map: true, has_roadmap: true, has_profile: true } });
  const profileOnly = await start({ probe: { ...START_STUBS.probe, has_profile: true } });
  const noRoadmap = await start({ probe: { ...START_STUBS.probe, has_value_map: true, has_profile: true } });
  const p = ran(first);
  return { first: p, valueMapBeforeAsk: at(p, "value_map") < at(p, "ask") && at(p, "value_map") > -1, out: out(first), resumed: { path: ran(resumed), out: out(resumed) }, profileOnly: ran(profileOnly), noRoadmap: ran(noRoadmap),
    valuePrompt: promptOf("project-start", "value_map"), profileWrites: first.called("profile_write").length };
}
async function k_c_newproject() {
  const full = await start();
  const quick = await start({}, {}, "quick");
  const off = await start({ tree: { ...START_STUBS.tree, enabled: "off" } });
  return { full: ran(full), quick: ran(quick), quickSkipped: quick.skipped, quickOut: out(quick), off: ran(off), offSkipped: off.skipped, requirementsCalls: [full, quick, off].map((sim) => sim.called("requirements").length), researchCalls: [full, quick, off].map((sim) => sim.called("research").length),
    recapOut: out(full).next_steps };
}

// ---------------------------------------------------------------- code analysis
async function analyze(mode: "quick" | "standard" | "full", scope: string) {
  const sim = await runSim("analyze-code", { input: { goal: "how the merge queue works", scope }, mode, stubs: { "lp.analyze": { decisions: [], risks: [], recommendation: "go", confidence: 78 }, report: { report_path: "reports/analysis-run.md" } } as never });
  return { path: sim.path, out: out(sim), analyze: sim.called("analyze")[0]?.input, reports: sim.called("report").length };
}
async function k_c_mapcode() {
  const std = await analyze("standard", "src/server");
  const full = await analyze("full", "src/server");
  return { std, full, reportPath: nodeOf("analyze-code", "report").path };
}
async function k_c_scan() {
  const quick = await analyze("quick", "src/rooms/phase");
  const std = await analyze("standard", "src/rooms/phase");
  return { quick, std };
}

export const observeG = {
  k_c_completems, k_c_mssummary, k_c_auditms, k_c_msgaps, k_c_cleanup, k_ws_preflight, k_ws_fullgate, k_ws_vendor, k_ws_infra, k_ws_push, k_ws_pr, k_ws_review, k_ws_track, k_ws_post,
  k_c_start, k_c_newproject, k_c_newmilestone, k_c_mapcode, k_c_scan,
};

// Region 15 · How we prove it — the behaviour proofs of the map nodes n1118–n1143 (docs/sma-evidence.md). Each test checks the
// result a card names (the rows written, the verdict returned, the manifest left behind), not that a function was called.
// The drill's Python is driven the way tests/sma/parity-j2-series-prep.test.ts drives it: the real module, the hub replaced by doubles.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readBoundedWorkspaceFile, sha256Hex } from "@lane-pilot/kit";
import type { Services } from "../../server";
import { createCore } from "../../src/rooms/core/server/core";
import { ATTEMPT_STATES, IllegalTransitionError, OPERATIONAL_MOVES, resolveTransition, TRANSITION_TABLE } from "../../src/rooms/contracts/state-machine";
import { checkReceipt, coverageRows, untermedGaps, type CoverageEntry } from "../../src/rooms/coverage";
import { BOOK_SECTIONS, brokenLink, GENESIS, partHash, renderBook, type BookPart } from "../../src/rooms/phase/logic";
import { appendPart, listParts } from "../../src/rooms/phase/store";
import { createRealtime, mountHelperSignals, REALTIME_WINDOW_MS } from "../../src/rooms/platform/server/realtime";
import { createAttempt, createRun, createTask, getReasoningTrace, inspectAttempt, openDatabase, saveReasoningTrace, transitionAttempt } from "../../src/rooms/plugin-db";
import { TRANSITION_KEY } from "../../src/rooms/storage";
import { markOutputChanges, outputHashes } from "../../packages/kit/src/hash";
import { saveTriage, triageSummary, untriagedAttempts } from "../../packages/run-insights/src/triage";
import { createPhaseDriver } from "../phase-driver";

const DRILL = fileURLToPath(new URL("../../scripts/lp-drill.py", import.meta.url));
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const open = () => { const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" }); return { bb, harness, db: openDatabase(bb) }; };
const seedAttempt = (db: ReturnType<typeof openDatabase>, id: string, run = "run_r15", project = "proj_r15") => {
  if (!db.prepare("SELECT 1 FROM lane_pilot_run WHERE id=?").get(run)) createRun(db, run, project, "bb", "/w");
  createTask(db, { id: `t_${id}`, runId: run, kind: "bb", contract: {} });
  createAttempt(db, { id, runId: run, taskId: `t_${id}` });
};

// ---------------------------------------------------------------------------------------------------------------------
// Durable records (n1118–n1128)
// ---------------------------------------------------------------------------------------------------------------------

describe("[sma:ar_ledger] the attempt ledger is appended, never rewritten", () => {
  it("every move is a journal row — a refused one too — and update or delete of the journal or of an attempt is refused", () => {
    const { db } = open();
    seedAttempt(db, "al1");
    transitionAttempt(db, "al1", "spawn_requested", { reason: "go" });
    transitionAttempt(db, "al1", "running", { reason: "go" });
    expect(() => transitionAttempt(db, "al1", "spawn_requested", { reason: "start again" })).toThrow(IllegalTransitionError);
    const rows = db.prepare("SELECT from_state, to_state, refused FROM lane_pilot_attempt_transition WHERE attempt_id='al1' ORDER BY rowid").all();
    expect(rows).toEqual([{ from_state: "queued", to_state: "spawn_requested", refused: 0 }, { from_state: "spawn_requested", to_state: "running", refused: 0 }, { from_state: "running", to_state: "spawn_requested", refused: 1 }]);
    const before = (db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_attempt_transition").get() as { n: number }).n;
    expect(() => db.prepare("UPDATE lane_pilot_attempt_transition SET reason='rewritten'").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM lane_pilot_attempt_transition").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM lane_pilot_attempt WHERE id='al1'").run()).toThrow(/append-only/);
    expect((db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_attempt_transition").get() as { n: number }).n).toBe(before);
    expect(db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_attempt WHERE id='al1'").get()).toEqual({ n: 1 });
  });
});

describe("[sma:ar_stamp] the stamp names the automaton by a key of its rule set", () => {
  it("the transition key is the digest of the states, the table and the operational moves, and the dossier shows it", () => {
    expect(TRANSITION_KEY).toBe(sha256Hex(JSON.stringify({ states: ATTEMPT_STATES, transitions: TRANSITION_TABLE, operational: OPERATIONAL_MOVES })));
    expect(TRANSITION_KEY).not.toBe(sha256Hex(JSON.stringify({ states: ATTEMPT_STATES, transitions: TRANSITION_TABLE, operational: [] })));
    const { db } = open();
    seedAttempt(db, "as1");
    saveReasoningTrace(db, { runId: "run_r15", attemptId: "as1", threadId: null, planSha256: "p", sourceLength: 1, requestedReasoningLevel: "r", effectiveReasoningLevel: "r", fallbackReason: null,
      providerId: "codex", model: "m", serviceTier: null, requestedServiceTier: "default", stamp: { stateMachineVersion: 1, harnessVersion: "h", transitionKey: TRANSITION_KEY, policySha256: "0".repeat(64) } });
    expect(getReasoningTrace(db, "as1")!.stamp).toMatchObject({ transitionKey: TRANSITION_KEY, harnessVersion: "h", policySha256: "0".repeat(64) });
    const dossier = inspectAttempt(db, "proj_r15", "as1")!.dossier as { reasoningTrace: { stamp: { transitionKey: string } } };
    expect(dossier.reasoningTrace.stamp.transitionKey).toBe(TRANSITION_KEY);
  });
});

describe("[sma:ar_run_dir] one attempt's stream, receipts, verifier input and verdict, read back", () => {
  it("the dossier carries the stored stream, the hashed verification commands and the barrier verdict of that attempt", () => {
    const { db } = open();
    createRun(db, "run_d", "proj_d");
    createTask(db, { id: "td", runId: "run_d", kind: "bb", contract: { verification: [{ command: "npm test" }, { command: "npm run lint" }] } });
    createAttempt(db, { id: "ad", runId: "run_d", taskId: "td" });
    saveReasoningTrace(db, { runId: "run_d", attemptId: "ad", threadId: "thr_w", planSha256: "p", sourceLength: 1, requestedReasoningLevel: "r", effectiveReasoningLevel: "r", fallbackReason: null,
      providerId: "codex", model: "m", serviceTier: null, requestedServiceTier: "default", stream: { excerpt: "wrote hello.txt", chars: 15, sha256: "s".repeat(64) } } as never);
    db.prepare("UPDATE lane_pilot_attempt SET barrier_json=? WHERE id='ad'").run(JSON.stringify({ gate: "validate", status: "passed" }));
    const dossier = inspectAttempt(db, "proj_d", "ad")!.dossier as Record<string, any>;
    expect(dossier.stream).toMatchObject({ excerpt: "wrote hello.txt" });
    expect(dossier.verifierInput).toEqual({ commands: ["npm test", "npm run lint"], sha256: sha256Hex(JSON.stringify(["npm test", "npm run lint"])) });
    expect(dossier.verdict).toEqual({ gate: "validate", status: "passed" });
    expect(inspectAttempt(db, "proj_other", "ad")).toBeNull();
  });
});

describe("[sma:ar_receipt] a verification row hashes its outputs and a re-run marks the item whose output changed", () => {
  it("only the command whose stdout hash differs from the recorded one is marked, with the expected hash beside it", () => {
    const rerun = (command: string, stdout: string) => ({ command, ...outputHashes({ stdout }) } as { command: string; stdoutSha256?: string; expectedStdoutSha256?: string; outputChanged?: boolean });
    const items = [rerun("npm test", "2 passed"), rerun("npm run lint", "clean"), rerun("npm run build", "ok")];
    const changed = markOutputChanges(items, [{ command: "npm test", stdoutSha256: sha256Hex("1 passed") }, { command: "npm run lint", stdoutSha256: sha256Hex("clean") }]);
    expect(changed).toBe(1);
    expect(items.map((row) => row.outputChanged)).toEqual([true, false, undefined]);
    expect(items[0]!.expectedStdoutSha256).toBe(sha256Hex("1 passed"));
    expect(outputHashes({ stdout: "x" })).toEqual({ stdoutSha256: sha256Hex("x"), stderrSha256: sha256Hex("") });
  });
});

describe("[sma:ar_book] the work book has nine sections, in order", () => {
  it("renders the nine headings in the card's order and each part under its own section", () => {
    expect([...BOOK_SECTIONS]).toEqual(["goal", "discussion", "plan", "design", "execution", "verification", "acceptance", "lessons", "decisions"]);
    const phase = { id: "ph_1", title: "Book", goal: "the goal text", stage: "execution", state: "active", edition: 1 } as never;
    const parts: BookPart[] = [];
    let prev = GENESIS;
    for (const [seq, section, kind] of [[1, "lessons", "lesson"], [2, "plan", "plan"], [3, "acceptance", "accepted"]] as const) {
      const part = { seq, at: 1_700_000_000_000 + seq, section, kind, text: `${kind} text` };
      const hash = partHash(prev, part);
      parts.push({ ...part, prevHash: prev, hash });
      prev = hash;
    }
    const text = renderBook(phase, parts);
    const headings = text.split("\n").filter((line) => line.startsWith("## "));
    expect(headings).toEqual(["## 1. Goal", "## 2. Discussion", "## 3. Plan", "## 4. Design", "## 5. Execution", "## 6. Verification", "## 7. Acceptance", "## 8. Lessons", "## 9. Decisions and returns"]);
    const lines = text.split("\n");
    expect(lines.indexOf(lines.find((line) => line.includes("**plan**"))!)).toBeLessThan(lines.indexOf(lines.find((line) => line.includes("**accepted**"))!));
    expect(lines.indexOf(lines.find((line) => line.includes("**accepted**"))!)).toBeLessThan(lines.indexOf(lines.find((line) => line.includes("**lesson**"))!));
  });
});

describe("[sma:ar_chain] the book continues in hashed parts and a rewritten part breaks the chain", () => {
  it("appended parts link to the previous hash from the genesis, and the first rewritten part is named", () => {
    const { db } = open();
    const first = appendPart(db, "ph_chain", { section: "goal", kind: "opened", text: "one", at: 1000 });
    const second = appendPart(db, "ph_chain", { section: "plan", kind: "admitted", text: "two", at: 2000 });
    const third = appendPart(db, "ph_chain", { section: "decisions", kind: "note", text: "three", at: 3000 });
    expect(first.prevHash).toBe(GENESIS);
    expect(second.prevHash).toBe(first.hash);
    expect(third.prevHash).toBe(second.hash);
    expect(first.hash).toBe(sha256Hex(`${GENESIS}\n1\n1000\ngoal\nopened\none`));
    expect(brokenLink(listParts(db, "ph_chain"))).toBeNull();
    const rewritten = listParts(db, "ph_chain").map((part) => (part.seq === 2 ? { ...part, text: "rewritten" } : part));
    expect(brokenLink(rewritten)).toBe(2);
    const relinked = listParts(db, "ph_chain").map((part) => (part.seq === 3 ? { ...part, prevHash: GENESIS } : part));
    expect(brokenLink(relinked)).toBe(3);
    expect(() => db.prepare("UPDATE lane_pilot_phase_part SET text='x' WHERE phase_id='ph_chain'").run()).toThrow(/append-only/);
  });
});

function phaseDriver() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.send", async () => ({}));
  harness.sdk.stub("threads.get", async () => ({ status: "idle" }));
  harness.sdk.stub("threads.list", async () => []);
  const db = openDatabase(bb);
  createRun(db, "run1", "projA");
  const make = () => createPhaseDriver(createCore(bb, db), { runBudgets: { get: () => undefined } } as unknown as Services).phases;
  return { phases: make(), again: make, db };
}

describe("[sma:ar_book_writer] a phase decision appends its part to the book", () => {
  it("stopping a wave writes an execution part with its text, chained to the opening part", async () => {
    const { phases, db } = phaseDriver();
    const phase = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Book", goal: "write the book" });
    await phases.stopWave({ phaseId: phase.id, by: "pm" });
    const parts = listParts(db, phase.id);
    const stopped = parts.find((part) => part.kind === "wave_stopped")!;
    expect(stopped).toMatchObject({ section: "execution", text: "nothing queued to cancel" });
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(stopped.prevHash).toBe(parts[parts.indexOf(stopped) - 1]!.hash);
    expect(brokenLink(parts)).toBeNull();
  });
});

describe("[sma:ar_journal] every attempt event and refusal is a line of the journal", () => {
  it("a move is a row with its reason; an illegal one is a refused row with the reason prefixed; a move on a settled attempt is refused", () => {
    const { db } = open();
    seedAttempt(db, "aj1");
    transitionAttempt(db, "aj1", "spawn_requested", { reason: "dispatch" });
    transitionAttempt(db, "aj1", "running", { reason: "started" });
    expect(() => transitionAttempt(db, "aj1", "queued", { reason: "writer says again" })).toThrow(IllegalTransitionError);
    transitionAttempt(db, "aj1", "cancel_requested", { reason: "owner stop" });
    transitionAttempt(db, "aj1", "canceled", { reason: "stop observed", cancelCode: "owner" });
    transitionAttempt(db, "aj1", "running", { reason: "late writer" });
    const rows = db.prepare("SELECT from_state AS f, to_state AS t, reason, refused AS r FROM lane_pilot_attempt_transition WHERE attempt_id='aj1' ORDER BY rowid").all();
    expect(rows).toEqual([
      { f: "queued", t: "spawn_requested", reason: "dispatch", r: 0 },
      { f: "spawn_requested", t: "running", reason: "started", r: 0 },
      { f: "running", t: "queued", reason: "illegal move: writer says again", r: 1 },
      { f: "running", t: "cancel_requested", reason: "owner stop", r: 0 },
      { f: "cancel_requested", t: "canceled", reason: "stop observed", r: 0 },
      { f: "canceled", t: "running", reason: "late writer", r: 1 },
    ]);
    expect((db.prepare("SELECT state FROM lane_pilot_attempt WHERE id='aj1'").get() as { state: string }).state).toBe("canceled");
  });
});

describe("[sma:ar_bugs] every failed attempt ends in the failure journal once", () => {
  it("a failed writer attempt is listed untriaged, saved with its origin and category, and then no longer listed", () => {
    const { db } = open();
    createRun(db, "run_f", "proj_f");
    createTask(db, { id: "tf", runId: "run_f", kind: "bb", contract: {} });
    createAttempt(db, { id: "af", runId: "run_f", taskId: "tf" });
    db.prepare("UPDATE lane_pilot_attempt SET state='validation_failed', reason='owns_paths rejected src/a.ts', updated_at=5000 WHERE id='af'").run();
    createTask(db, { id: "tok", runId: "run_f", kind: "bb", contract: {} });
    createAttempt(db, { id: "aok", runId: "run_f", taskId: "tok" });
    db.prepare("UPDATE lane_pilot_attempt SET state='accepted', reason='fine', updated_at=5001 WHERE id='aok'").run();
    const open1 = untriagedAttempts(db, "proj_f", 0);
    expect(open1.map((row) => row.attemptId)).toEqual(["af"]);
    saveTriage(db, "proj_f", open1[0]!, { status: "ok", origin: "writer", originConfidence: 0.6, category: "outside_scope", detail: "rule:writer_fault_state" }, 6000);
    expect(db.prepare("SELECT attempt_id, origin, category, status FROM lane_pilot_failure_triage").all()).toEqual([{ attempt_id: "af", origin: "writer", category: "outside_scope", status: "ok" }]);
    expect(untriagedAttempts(db, "proj_f", 0)).toEqual([]);
    expect(triageSummary(db, "proj_f", 0)).toMatchObject({ total: 1, byOrigin: { writer: 1 }, errors: 0, lastTriagedAt: 6000 });
    db.prepare("UPDATE lane_pilot_attempt SET reason='verification failed: npm test', updated_at=7000 WHERE id='af'").run();
    expect(untriagedAttempts(db, "proj_f", 0).map((row) => row.attemptId)).toEqual(["af"]);
  });
});

describe("[sma:ar_events] a row change reaches the window as one signal on the project's stream", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("a burst of changes is one signal carrying only what to re-read, and an attempt move of a PM chat's run signals its helpers", () => {
    const { bb, harness, db } = open();
    const realtime = createRealtime(bb, () => undefined);
    realtime.notify("proj_1", "workflow", "thr_a", "wfrun_1");
    realtime.notify("proj_1", "workflow", "thr_a", "wfrun_1");
    realtime.notify("proj_1", "workflow", "thr_a", "wfrun_2");
    expect(harness.realtimeSignals).toHaveLength(0);
    vi.advanceTimersByTime(REALTIME_WINDOW_MS + 1);
    expect(harness.realtimeSignals.map((row) => ({ channel: row.channel, payload: row.payload }))).toEqual([
      { channel: "lp:proj_1", payload: { kind: "workflow", threadId: "thr_a", runId: "wfrun_1" } },
      { channel: "lp:proj_1", payload: { kind: "workflow", threadId: "thr_a", runId: "wfrun_2" } },
    ]);
    harness.realtimeSignals.length = 0;
    createRun(db, "run_rt", "proj_rt", "bb", "/w");
    db.prepare("UPDATE lane_pilot_run SET pm_thread_id='thr_pm' WHERE id='run_rt'").run();
    const stop = mountHelperSignals(bb, db, realtime);
    seedAttempt(db, "art1", "run_rt", "proj_rt");
    transitionAttempt(db, "art1", "spawn_requested", { reason: "go" });
    vi.advanceTimersByTime(REALTIME_WINDOW_MS + 1);
    expect(harness.realtimeSignals.map((row) => ({ channel: row.channel, payload: row.payload }))).toEqual([{ channel: "lp:proj_rt", payload: { kind: "helpers", threadId: "thr_pm" } }]);
    stop();
    realtime.dispose();
  });
});

describe("[sma:ar_holds] a stopped wave is a row, found where it was left", () => {
  it("the stop pauses the phase and appends its part; a new driver reads the paused phase and the part; the part cannot be rewritten", async () => {
    const { phases, again, db } = phaseDriver();
    const phase = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Hold", goal: "hold the wave" });
    expect(phases.status(phase.id).phase.state).not.toBe("paused");
    await phases.stopWave({ phaseId: phase.id, by: "pm" });
    const restarted = again();
    expect(restarted.status(phase.id).phase.state).toBe("paused");
    expect(listParts(db, phase.id).filter((part) => part.kind === "wave_stopped")).toHaveLength(1);
    expect(() => db.prepare("DELETE FROM lane_pilot_phase_part WHERE kind='wave_stopped'").run()).toThrow(/append-only/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Graph release series — the registry half (n1136–n1138)
// ---------------------------------------------------------------------------------------------------------------------

describe("[sma:rl_regressions] the catalogue names the live drill scenario of each graph suite", () => {
  it("task, batch and phase each have a stage or mechanism claimed live by a scenario of that suite, and a receipt confirms or refutes the claim", () => {
    const rows = coverageRows();
    const liveBy = (scenario: string) => rows.filter((row) => row.status === "live" && row.live.includes(scenario));
    expect(liveBy("parallel3").length).toBeGreaterThan(0);
    expect(liveBy("phase").length + liveBy("phase_route").length).toBeGreaterThan(0);
    expect(liveBy("helper_providers").length + liveBy("flow_contract").length + liveBy("live_word").length).toBeGreaterThan(0);
    const claim = rows.find((row) => row.kind === "stage" && row.id === "writer-agent")!;
    expect(claim.status).toBe("live");
    const seen = checkReceipt([claim], { scenarioNames: ["parallel3"], seen: { stages: { "writer-agent": { passed: 3 } } } });
    expect(seen).toMatchObject({ checked: 1, confirmed: 1, notSeen: [] });
    const missed = checkReceipt([claim], { scenarioNames: ["parallel3"], seen: { stages: { "writer-agent": { skipped: 3 } } } });
    expect(missed).toMatchObject({ checked: 1, confirmed: 0 });
    expect(missed.notSeen).toEqual(["stage:writer-agent (claimed by parallel3)"]);
  });
});

describe("[sma:rl_not_covered] a node nobody proves is listed with its reason", () => {
  it("an entry with neither a drill scenario nor a test is status none and carries its reason; a test-only entry carries the reason no drill runs it", () => {
    const entries: CoverageEntry[] = [
      { kind: "mechanism", ids: ["x.none"], reason: "deferral:x-none, the owner scoped it out of the live series" },
      { kind: "mechanism", ids: ["x.tests"], tests: ["tests/x.test.ts"], reason: "no drill step takes it" },
      { kind: "mechanism", ids: ["x.live"], live: ["parallel3"], via: "every drill task passes it" },
    ];
    const rows = coverageRows(entries).filter((row) => row.id.startsWith("x."));
    expect(rows.map((row) => [row.id, row.status, row.note])).toEqual([
      ["x.none", "none", "deferral:x-none, the owner scoped it out of the live series"],
      ["x.tests", "tests", "no drill step takes it"],
      ["x.live", "live", "every drill task passes it"],
    ]);
    // the real catalogue: every uncovered row says why
    const none = coverageRows().filter((row) => row.status === "none");
    expect(none.length).toBeGreaterThan(0);
    expect(none.every((row) => row.note.length > 20)).toBe(true);
  });
});

describe("[sma:rl_terms] a deferral without a term or the owner's word is a gap", () => {
  it("the untermed rows are exactly the uncovered rows whose note names no deferral, owner or владелец", () => {
    const row = (id: string, status: "none" | "live", note: string) => ({ kind: "mechanism" as const, id, status, live: [], tests: [], note });
    const gaps = untermedGaps([
      row("a", "none", "no reason with a term"),
      row("b", "none", "deferral:b-2026-12 until the hub moves"),
      row("c", "none", "owner: not before the release"),
      row("d", "none", "решение владелец принял"),
      row("e", "live", "no term needed when proven live"),
    ]);
    expect(gaps.map((entry) => entry.id)).toEqual(["a"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Worker stories (n1133)
// ---------------------------------------------------------------------------------------------------------------------

describe("[sma:rl_stories] real worker boundaries, and a worker cannot accept its own work", () => {
  it("a worker read refuses '..', an absolute path and a symlink; only checks_passed reaches accepted from running", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lp-r15-story-"));
    dirs.push(cwd);
    writeFileSync(join(cwd, "inside.txt"), "hello\n");
    symlinkSync("/etc/hostname", join(cwd, "link.txt"));
    const read = (relativePath: string) => readBoundedWorkspaceFile({ hostId: "h", projectCwd: cwd, relativePath, offset: 0, maxLines: 10 });
    await expect(read("../outside.txt")).rejects.toThrow(/escaped|symlink|directory/);
    await expect(read("/etc/passwd")).rejects.toThrow();
    await expect(read("link.txt")).rejects.toThrow(/symlink/);
    expect((await read("inside.txt")).truncated).toBe(false);
    const events = [...new Set(TRANSITION_TABLE.map((row) => row.event))];
    const reaching = events.filter((event) => { try { return resolveTransition("running", event) === "accepted"; } catch { return false; } });
    expect(reaching).toEqual(["checks_passed"]);
    expect(TRANSITION_TABLE.filter((row) => row.to === "accepted").map((row) => `${row.from}+${row.event}`)).toEqual(["running+checks_passed"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Graph release series — the drill's Python (n1129–n1135, n1139–n1143)
// ---------------------------------------------------------------------------------------------------------------------

/** Runs `body` against the real lp-drill.py module, the hub replaced; `body` prints nothing and sets `out` (a JSON-able value). */
function door(body: string): any { // guardian: allow — the drill's JSON answer, read field by field by each test
  const dir = mkdtempSync(join(tmpdir(), "lp-sma-r15-"));
  dirs.push(dir);
  const code = `
import importlib.util, json, os, sys, pathlib, contextlib, io, time
os.environ["LP_DRILL_RECEIPT_DIR"] = ${JSON.stringify(dir)}
for key in ("LP_DRILL_UI_URL", "LP_DRILL_UI_ACCESS_URL", "LP_DRILL_LIVE_PRESS", "LP_DRILL_SERIES"):
    os.environ.pop(key, None)
spec = importlib.util.spec_from_file_location("drill", ${JSON.stringify(DRILL)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.log = lambda *a, **k: None
real_run = m.run
TMP = pathlib.Path(${JSON.stringify(dir)})
def series(argv, fake_run, problems=None, coverage=None):
    """main() of the drill with the hub-bound preparation and metrics replaced; fake_run(args) -> (rc, stdout)."""
    calls = []
    m.series_preparation = lambda names=None: {"commit": "c0ffee", "version": "0.0.0", "scout": {"unlisted": [], "undefined": []}, "sandboxClean": True, "checks": [], "problems": problems or [], "coverageGaps": coverage or []}
    m.series_metrics = lambda scenes, d: {"suite": "metrics", "verdict": "pass", "problems": [], "scenes": len(scenes), "receipts": 0}
    def run(args, stdin=None, timeout=180, env=None):
        calls.append(list(args))
        rc, out = fake_run(list(args))
        return rc, out, ""
    m.run = run
    sys.argv = ["lp-drill.py", *argv]
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
        rc = m.main()
    manifests = sorted(TMP.glob("series-*.json"))
    return {"rc": rc, "calls": calls, "manifest": json.loads(manifests[-1].read_text()) if manifests else None, "stdout": buf.getvalue()}
def receipt_run(args):
    if args[1:2] == ["-I"]:
        name = args[4]
        path = TMP / f"scene-{name}.json"
        path.write_text(json.dumps({"seen": {"stages": {}}, "judged": [{"name": name, "verdict": "pass"}], "scenarios": [{"name": name, "result": "pass"}]}))
        return 0, f"RECEIPT={path}\\n"
    return 0, ""
${body}
print(json.dumps({"out": out}))
`;
  const res = spawnSync("python3", ["-I", "-c", code], { encoding: "utf8", timeout: 120_000 });
  if (res.status !== 0) throw new Error(res.stderr.slice(0, 1500));
  return JSON.parse(res.stdout.trim().split("\n").pop()!).out;
}

const SUITE_ORDER = ["task", "batch", "phase", "release", "window", "worker", "lockstep", "wiring"];

describe("[sma:rl_series] the series runs the suites in order and is judged as a whole", () => {
  it("every scene runs once in its suite's turn, the manifest names the head and the verdict, and one failed scene fails the series", () => {
    const out = door(`
out = {"green": series(["--series"], receipt_run), "red": series(["--series"], lambda args: (1, "") if args[-1] == "phase" else receipt_run(args))}
`);
    const order = out.green.manifest.scenes.map((row: { suite: string }) => row.suite);
    expect([...new Set(order)]).toEqual(SUITE_ORDER);
    expect(order).toEqual([...order].sort((a: string, b: string) => SUITE_ORDER.indexOf(a) - SUITE_ORDER.indexOf(b)));
    expect(out.green.manifest).toMatchObject({ kind: "lane-pilot-release-series", verdict: "pass", preparation: { commit: "c0ffee" } });
    expect(out.green.manifest.scenes.filter((row: { name: string }) => row.name === "phase")).toHaveLength(1);
    expect(out.green.rc).toBe(0);
    expect(out.red.manifest.verdict).toBe("fail");
    expect(out.red.manifest.scenes.find((row: { name: string }) => row.name === "phase").exit).toBe(1);
    expect(out.red.rc).toBe(1);
  });
});

describe("[sma:rl_prep] a series with an unready part, or a red coverage verdict, never starts a scene", () => {
  it("main refuses with exit 2 on a preparation problem and exit 1 on coverage gaps, and runs nothing", () => {
    const out = door(`
out = {"problem": series(["--series"], receipt_run, problems=["window: the writer host is not listed"]), "gaps": series(["--series"], receipt_run, coverage=["node x: no term"])}
`);
    expect(out.problem.rc).toBe(2);
    expect(out.problem.calls).toEqual([]);
    expect(out.problem.manifest).toBeNull();
    expect(out.gaps.rc).toBe(1);
    expect(out.gaps.calls).toEqual([]);
  });
});

describe("[sma:rl_sequence] the phase suite's scene carries a phase to its verification and says where it stopped", () => {
  const phase = (stage: string, book: string) => door(`
calls = []
def rpc(method, payload):
    calls.append([method, payload.get("action")])
    if method == "phase_act": return {"phase": {"id": "ph_x"}}
    if method == "phase_get": return {"phase": {"stage": ${JSON.stringify(stage)}, "state": "active", "record": {}}, "book": ${JSON.stringify(book)}}
    return {}
m.setting_rpc = rpc
m.POLL_SEC = 0
class Ctx: project = "proj_x"; pm = "thr_pm"
result = m.scenario_phase(Ctx())
out = {"result": result, "calls": calls}
`);
  const BOOK = "- 2026-11-14 10:00 **admitted** — the plan is admitted\n- 2026-11-14 10:01 **issued** — wave 1";

  it("a phase at verification with an admitted plan passes; one stuck in planning fails naming the stage; the phase is closed either way", () => {
    const green = phase("verification", BOOK);
    expect(green.result).toMatchObject({ name: "phase", result: "pass", problems: [] });
    expect(green.calls).toContainEqual(["phase_control", "close"]);
    const stuck = door(`
calls = []
def rpc(method, payload):
    calls.append([method, payload.get("action")])
    if method == "phase_act": return {"phase": {"id": "ph_x"}}
    if method == "phase_get": return {"phase": {"stage": "planning", "state": "active", "record": {}}, "book": ""}
    return {}
m.setting_rpc = rpc
m.TIMEOUT_MIN = 0
m.PHASE_TIMEOUT_MIN = 0
class Ctx: project = "proj_x"; pm = "thr_pm"
out = {"result": m.scenario_phase(Ctx()), "calls": calls}
`);
    expect(stuck.result.result).toBe("fail");
    expect(stuck.result.problems).toContain("the phase did not reach verification: it is at planning (active)");
    expect(stuck.result.problems).toContain("the book has no admitted plan");
    expect(stuck.calls).toContainEqual(["phase_control", "close"]);
  });
});

describe("[sma:rl_suites] every scenario sits in exactly one of the nine named suites", () => {
  it("the scout names no ungrouped, regrouped or unknown scenario, and the suites are the nine of the card in order", () => {
    const out = door(`out = m.scout()`);
    expect(Object.keys(out.suites)).toEqual([...SUITE_ORDER, "metrics"]);
    expect([out.ungrouped, out.regrouped, out.unknown, out.unlisted, out.undefined, out.missingStories, out.empty]).toEqual([[], [], [], [], [], [], []]);
    expect(out.suites.window).toEqual(["vitest:tests/release-stories-window.test.tsx"]);
  });
});

describe("[sma:rl_scenes] each scene runs in a process of its own, and a hung scene does not stop the next", () => {
  it("every scene is its own interpreter call with its own name; a scene that times out is exit 124 and the rest still run", () => {
    const out = door(`
def hang_first(args):
    if args[1:2] == ["-I"] and args[4] == "parallel3":
        return real_run(["sleep", "30"], timeout=1)[:2]
    return receipt_run(args)
t0 = time.time()
res = series(["--series"], hang_first)
scenes = [c for c in res["calls"] if c[1:2] == ["-I"]]
out = {"scenes": scenes, "manifest": res["manifest"], "rc": res["rc"], "seconds": time.time() - t0, "script": ${JSON.stringify(DRILL)}, "direct": list(real_run(["sleep", "30"], timeout=1)[:2])}
`);
    expect(out.scenes.length).toBeGreaterThan(20);
    expect(out.scenes.every((call: string[]) => call[2] === out.script && call[3] === "--scenario")).toBe(true);
    expect(new Set(out.scenes.map((call: string[]) => call[4])).size).toBe(out.scenes.length);
    const hung = out.manifest.scenes.find((row: { name: string }) => row.name === "parallel3");
    expect(hung.exit).toBe(124);
    expect(out.manifest.scenes.filter((row: { exit: number }) => row.exit === 0).length).toBe(out.manifest.scenes.length - 1);
    expect(out.manifest.verdict).toBe("fail");
    expect(out.direct[0]).toBe(124);
    expect(out.seconds).toBeLessThan(60);
  });
});

describe("[sma:rl_scout] a run names what it runs and never counts as a release", () => {
  it("--scenario runs exactly the named scenes, prepares no series and leaves no manifest; --scout only lists", () => {
    const out = door(`
def dry(argv):
    m.series_preparation = lambda names=None: (_ for _ in ()).throw(AssertionError("a named run must not prepare a series"))
    sys.argv = ["lp-drill.py", *argv]
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
        rc = m.main()
    return {"rc": rc, "line": next(l for l in buf.getvalue().splitlines() if l.startswith("drill ") and "scenarios:" in l).split("scenarios: ", 1)[1], "files": sorted(p.name for p in TMP.glob("*.json"))}
out = {"one": dry(["--scenario", "phase", "--dry-run"]), "two": dry(["--scenario", "guard_hash,phase", "--dry-run"]), "unknown": None}
sys.argv = ["lp-drill.py", "--scenario", "nope", "--dry-run"]
with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
    out["unknown"] = m.main()
`);
    expect(out.one).toEqual({ rc: 0, line: "phase", files: [] });
    expect(out.two).toEqual({ rc: 0, line: "guard_hash, phase", files: [] });
    expect(out.unknown).toBe(2);
  });
});

describe("[sma:rl_manifest] the manifest names the head, the start, the preparation and only the selected units", () => {
  it("--suite window leaves one scene under its suite, every other suite empty, and the commit the preparation saw", () => {
    const out = door(`out = series(["--suite", "window"], receipt_run)`);
    const manifest = out.manifest;
    expect(manifest).toMatchObject({ kind: "lane-pilot-release-series", preparation: { commit: "c0ffee", scout: { unlisted: [], undefined: [] } }, verdict: "pass" });
    expect(manifest.stamp).toMatch(/^\d{8}-\d{6}$/);
    expect(manifest.scenes.map((row: { name: string }) => row.name)).toEqual(["vitest:tests/release-stories-window.test.tsx"]);
    expect(Object.fromEntries(Object.entries(manifest.suites).map(([name, rows]) => [name, (rows as unknown[]).length]))).toMatchObject({ window: 1, task: 0, worker: 0, phase: 0, metrics: 0 });
    expect(out.calls).toEqual([["npx", "vitest", "run", "tests/release-stories-window.test.tsx"]]);
  });
});

describe("[sma:rl_report] a scene passes only with evidence, and a skipped one stays skipped", () => {
  it("judges a pass with evidence, a pass without, a failure with its problems, and a skip", () => {
    const out = door(`
out = [m.judge_scenario(s) for s in (
  {"name": "a", "result": "pass", "problems": [], "tasks": 3},
  {"name": "b", "result": "pass", "problems": []},
  {"name": "c", "result": "pass", "problems": [], "note": "ran nothing, said why"},
  {"name": "d", "result": "fail", "problems": ["no commit"], "tasks": 1},
  {"name": "e", "result": "skipped", "problems": []},
)]
`);
    expect(out.map((row: { name: string; verdict: string }) => [row.name, row.verdict])).toEqual([["a", "pass"], ["b", "fail"], ["c", "pass"], ["d", "fail"], ["e", "skipped"]]);
    expect(out[0].evidence).toEqual(["tasks"]);
    expect(out[1].why).toBe("a pass without evidence");
    expect(out[3].why).toBe("no commit");
  });
});

describe("[sma:rl_judge] the series verdict needs every named scene judged and none failed", () => {
  it("a missing scene fails, a failed scene fails, skipped ones are named and do not fail", () => {
    const out = door(`
judged = lambda *rows: [{"name": n, "verdict": v} for n, v in rows]
out = [m.judge_series(judged(("a", "pass"), ("b", "pass")), ["a", "b"]),
       m.judge_series(judged(("a", "pass")), ["a", "b"]),
       m.judge_series(judged(("a", "pass"), ("b", "fail")), ["a", "b"]),
       m.judge_series(judged(("a", "pass"), ("b", "skipped")), ["a", "b"])]
`);
    expect(out).toEqual([
      { verdict: "pass", missing: [], failed: [], skipped: [] },
      { verdict: "fail", missing: ["b"], failed: [], skipped: [] },
      { verdict: "fail", missing: [], failed: ["b"], skipped: [] },
      { verdict: "pass", missing: [], failed: [], skipped: ["b"] },
    ]);
  });
});

describe("[sma:rl_evidence] a run's records are read back nested, and an unreadable hub is no evidence", () => {
  it("stages, gates and attempt moves come back as name -> state -> count; a hub that fails gives null", () => {
    const out = door(`
def hub(sql):
    if "lane_pilot_stage_receipt" in sql: return [{"k": "writer-agent", "v": "passed", "n": 3}, {"k": "writer-agent", "v": "failed", "n": 1}, {"k": "verification", "v": "passed", "n": 3}]
    if "lane_pilot_gate_event" in sql: return [{"k": "validate", "v": "passed", "n": 2}]
    return [{"k": "queued>spawn_requested", "v": "ok", "n": 3}, {"k": "running>accepted", "v": "refused", "n": 1}]
m.hubsql = hub
seen = m.evidence_seen("run_1")
def down(sql): raise RuntimeError("ssh down")
m.hubsql = down
out = {"seen": seen, "down": m.evidence_seen("run_1")}
`);
    expect(out.seen).toEqual({
      stages: { verification: { passed: 3 }, "writer-agent": { failed: 1, passed: 3 } },
      gates: { validate: { passed: 2 } },
      moves: { "queued>spawn_requested": { ok: 3 }, "running>accepted": { refused: 1 } },
    });
    expect(out.down).toBeNull();
  });
});

describe("[sma:rl_metrics] the metrics suite judges the archive last", () => {
  it("a scene that exited non-zero, left no evidence, or an accepted share under the floor fails the series; a clean archive passes", () => {
    const out = door(`
m.setting_rpc = lambda method, payload: {}
def receipts(rows):
    scenes = []
    for i, (exit_code, scenarios, evidence) in enumerate(rows):
        path = TMP / f"r{i}.json"
        path.write_text(json.dumps({"seen": {"stages": {}} if evidence else None, "judged": [], "scenarios": [{"result": r} for r in scenarios]}))
        scenes.append({"name": f"s{i}", "suite": "task", "exit": exit_code, "receipt": str(path)})
    r = m.series_metrics(scenes, TMP)
    return {"verdict": r["verdict"], "problems": r["problems"]}
out = {"clean": receipts([(0, ["pass", "pass"], True)]), "exit": receipts([(3, ["pass"], True)]), "blind": receipts([(0, ["pass"], False)]),
       "floor": receipts([(0, ["pass", "fail", "fail"], True)]), "half": receipts([(0, ["pass", "fail"], True)])}
`);
    expect(out.clean).toEqual({ verdict: "pass", problems: [] });
    expect(out.exit.problems).toEqual(["scene s0 exited 3"]);
    expect(out.blind.problems).toEqual(["scene s0 left no evidence"]);
    expect(out.floor.verdict).toBe("fail");
    expect(out.floor.problems[0]).toMatch(/only 1\/3 scenario verdicts are green, under the 0\.5 floor/);
    expect(out.half).toEqual({ verdict: "pass", problems: [] });
  });
});

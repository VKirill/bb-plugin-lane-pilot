import { describe, expect, it } from "vitest";
import { EVIDENCE_WAIT_MS, decideAcceptance, gateRepair, repairChange, type AcceptanceEvidence } from "../../src/rooms/wall/acceptance";
import { parseNightReport, repairBrief, recurrenceSql } from "../../src/rooms/wall/brief";
import { checkFinding, judgeHunt, parseFinding, type EvidencePack, type Finding } from "../../src/rooms/wall/pack";
import type { WallClass } from "../../src/rooms/wall/types";

const pack: EvidencePack = {
  kind: "task", subject: "run_1/P1", facts: [],
  attempts: [{ id: "a1", state: "validation_failed", reason: "owns_paths rejected src/i18n/en.json", project: "p", version: "0.1.268", at: 1 }],
  receipts: [{ runId: "run_1", taskId: "P1", stage: "writer-agent", state: "failed", reason: "owns_paths rejected src/i18n/en.json" }],
  files: [{ path: "TASK", lines: 3, text: '{"owns_paths":["src/pages/**"],\n"expected_outputs":["src/i18n/en.json"],\n"verification":[]}' }],
  checkOutputs: ["owns_paths rejected src/i18n/en.json"],
  queries: [{ id: "same_fingerprint_14d", sql: "select", rows: [{ task_id: "P2", state: "validation_failed" }] }],
};
const finding = (patch: Partial<Finding> = {}): Finding => ({
  angle: "task", verdict: "contract_wrong", summary: "the contract expects a file it does not own", action: "update_contract",
  evidence: [{ kind: "file", ref: "TASK", line: 2, quote: '"expected_outputs":["src/i18n/en.json"]' }, { kind: "receipt", ref: "run_1/P1/writer-agent", quote: "owns_paths rejected src/i18n/en.json" }], ...patch,
});

describe("what the hunters say is checked by code against the pack", () => {
  it("a finding whose citations hold stays", () => {
    const checked = checkFinding(pack, finding());
    expect(checked).toMatchObject({ verdict: "contract_wrong", action: "update_contract", held: 2, demoted: false });
  });

  it("a citation that does not hold lowers the finding to unknown with no action", () => {
    const badLine = checkFinding(pack, finding({ evidence: [{ kind: "file", ref: "TASK", line: 99, quote: "expected_outputs" }] }));
    expect(badLine).toMatchObject({ verdict: "unknown", action: "none", demoted: true });
    expect(badLine.summary).toMatch(/no line 99/);
    expect(checkFinding(pack, finding({ evidence: [{ kind: "file", ref: "src/nowhere.ts", quote: "something real" }] })).verdict).toBe("unknown");
    expect(checkFinding(pack, finding({ evidence: [{ kind: "receipt", ref: "run_1/P1/verification", quote: "owns_paths rejected" }] })).verdict).toBe("unknown");
    expect(checkFinding(pack, finding({ evidence: [{ kind: "sql", ref: "same_fingerprint_14d", quote: "invented text row" }] })).verdict).toBe("unknown");
    expect(checkFinding(pack, finding({ evidence: [{ kind: "check_output", ref: "x", quote: "the log never said this" }] })).verdict).toBe("unknown");
    expect(checkFinding(pack, finding({ evidence: [] })).verdict).toBe("unknown");
    // One bad citation among good ones is enough.
    expect(checkFinding(pack, finding({ evidence: [...finding().evidence, { kind: "sql", ref: "nope", quote: "whatever it is" }] })).verdict).toBe("unknown");
  });

  it("the hunt is usable when one hunter held, unknown when none did", () => {
    const usable = judgeHunt(pack, [finding(), parseFinding({ verdict: "unknown", summary: "can't tell", evidence: [], action: "none" }, "system"), null]);
    expect(usable.state).toBe("usable");
    expect(usable.usable).toHaveLength(1);
    const none = judgeHunt(pack, [finding({ evidence: [{ kind: "file", ref: "TASK", line: 50, quote: "not in the file at all" }] }), null, null]);
    expect(none).toMatchObject({ state: "unknown", demoted: 1 });
  });

  it("a reply that is not the shape is no finding", () => {
    expect(parseFinding({ verdict: "dunno", summary: "x", evidence: [], action: "none" }, "task")).toBeNull();
    expect(parseFinding("text", "task")).toBeNull();
  });
});

const evidence = (patch: Partial<AcceptanceEvidence> = {}): AcceptanceEvidence => ({
  merged: true, versionBefore: "0.1.268", deployedVersion: "0.1.269", drill: { version: "0.1.269", at: 20, ok: true }, deployedAt: 10,
  canary: { version: "0.1.269", tripped: false, windowOpen: false }, bench: "pass", recurrence: { failures: 0, attempts: 25, exposed: true }, trainRolledBack: false, ...patch,
});

describe("acceptance of a night repair", () => {
  it("accepts when the train shipped it, the drill and canary are green, the bench subset is not worse and the class stopped", () => {
    const result = decideAcceptance(evidence());
    expect(result.state).toBe("accepted");
    expect(result.checks.map((row) => row.name)).toEqual(["release train", "deploy drill", "canary", "bench subset", "class recurrence on the new version"]);
  });

  it("waits for each fact in turn", () => {
    expect(decideAcceptance(evidence({ merged: false })).state).toBe("pending");
    expect(decideAcceptance(evidence({ deployedVersion: null })).reason).toMatch(/waits for the release train/);
    // No drill receipt of this version is no evidence: the train's rollback on a red drill is an inference, not a receipt (Astra, 2026-10-27).
    const noDrill = decideAcceptance(evidence({ drill: null }));
    expect(noDrill).toMatchObject({ state: "pending", action: "none", reason: expect.stringMatching(/no drill receipt/) });
    expect(noDrill.checks.find((row) => row.name === "deploy drill")).toMatchObject({ ok: null });
    expect(decideAcceptance(evidence({ drill: { version: "0.1.268", at: 20, ok: true } })).state).toBe("pending");
    expect(decideAcceptance(evidence({ drill: { version: "0.1.269", at: 5, ok: true } })).state).toBe("pending");
    expect(decideAcceptance(evidence({ drill: { version: "0.1.269", at: 20, ok: true } })).checks.find((row) => row.name === "deploy drill")?.ok).toBe(true);
    expect(decideAcceptance(evidence({ canary: { version: "0.1.269", tripped: false, windowOpen: true } })).reason).toMatch(/window is still open/);
    expect(decideAcceptance(evidence({ bench: "pending" })).state).toBe("pending");
  });

  it("red drill: rolled back (the train restores the dist); tripped canary and a worse bench: red with a revert in code", () => {
    expect(decideAcceptance(evidence({ drill: { version: "0.1.269", at: 20, ok: false } }))).toMatchObject({ state: "rolled_back", action: "none" });
    expect(decideAcceptance(evidence({ canary: { version: "0.1.269", tripped: true, windowOpen: false } }))).toMatchObject({ state: "red", action: "revert" });
    expect(decideAcceptance(evidence({ bench: "fail" }))).toMatchObject({ state: "red", action: "revert" });
    expect(decideAcceptance(evidence({ trainRolledBack: true })).state).toBe("rolled_back");
  });

  it("a repair whose class recurred is not accepted: a failed round that the night reverts; too few attempts prove nothing", () => {
    expect(decideAcceptance(evidence({ recurrence: { failures: 2, attempts: 30, exposed: true } }))).toMatchObject({ state: "red", action: "revert", recurred: true });
    expect(decideAcceptance(evidence({ recurrence: { failures: 2, attempts: 4, exposed: true } })).recurred).toBe(false);
    expect(decideAcceptance(evidence({ bench: "unavailable" })).checks.find((row) => row.name === "bench subset")!.ok).toBeNull();
  });
});

describe("acceptance asks for evidence, absence is not proof (review of 2026-10-26, section 2)", () => {
  it("a quiet canary with no bench and no attempts is not an acceptance: the review's input stays pending", () => {
    // The review's call: merged, shipped, no drill, quiet closed canary, bench unavailable, recurrence null. It was `accepted, all checks green`.
    const result = decideAcceptance({ merged: true, versionBefore: "a", deployedVersion: "b", deployedAt: 1, drill: null, canary: { version: "b", tripped: false, windowOpen: false },
      bench: "unavailable", recurrence: null, trainRolledBack: false });
    expect(result.state).toBe("pending");
    expect(result.reason).toMatch(/no proof yet/);
  });

  it("Astra's call: a quiet closed canary, no bench, no drill, the class in 10 of 10 attempts: not accepted, reverted; quiet, it is still pending", () => {
    const quiet = { drill: null, bench: "unavailable" as const };
    const recurred = decideAcceptance(evidence({ ...quiet, recurrence: { failures: 10, attempts: 10, exposed: true } }));
    expect(recurred).toMatchObject({ state: "red", action: "revert", recurred: true });
    expect(recurred.reason).toMatch(/not accepted/);
    // Clean attempts, but no drill receipt: the repair waits for it.
    expect(decideAcceptance(evidence({ ...quiet, recurrence: { failures: 0, attempts: 10, exposed: true } }))).toMatchObject({ state: "pending" });
  });

  it("attempts that were not exposed to the class prove nothing: no failure among them is not a fix", () => {
    const unknown = decideAcceptance(evidence({ bench: "unavailable", recurrence: { failures: 0, attempts: 40, exposed: false } }));
    expect(unknown.state).toBe("pending");
    expect(unknown.reason).toMatch(/exposed to the class/);
    // A failure of the class is a failure wherever it came from.
    expect(decideAcceptance(evidence({ bench: "unavailable", recurrence: { failures: 1, attempts: 40, exposed: false } }))).toMatchObject({ state: "red", action: "revert" });
    expect(decideAcceptance(evidence({ bench: "pass", recurrence: { failures: 0, attempts: 40, exposed: false } })).state).toBe("accepted");
  });

  it("a repair of the judge or the graph is judged by the bench alone, not by the recurrence of its class", () => {
    expect(decideAcceptance(evidence({ requireBench: true, bench: "pass", recurrence: { failures: 3, attempts: 30, exposed: true } }))).toMatchObject({ state: "accepted", recurred: true });
  });

  it("an inconclusive bench is no evidence either: only enough attempts of the new version, or a passed bench, accept", () => {
    expect(decideAcceptance(evidence({ bench: "inconclusive", recurrence: { failures: 0, attempts: 3, exposed: true } })).state).toBe("pending");
    expect(decideAcceptance(evidence({ bench: "inconclusive", recurrence: { failures: 0, attempts: 3, exposed: true } })).checks.find((row) => row.name === "bench subset")).toMatchObject({ ok: null });
    expect(decideAcceptance(evidence({ bench: "inconclusive", recurrence: { failures: 0, attempts: 12, exposed: true } })).state).toBe("accepted");
    expect(decideAcceptance(evidence({ bench: "pass", recurrence: null })).state).toBe("accepted");
  });

  it("a repair of the judge or the graph needs the passed bench itself; attempts alone do not accept it", () => {
    expect(decideAcceptance(evidence({ requireBench: true, bench: "unavailable", recurrence: { failures: 0, attempts: 40, exposed: true } })).state).toBe("pending");
    expect(decideAcceptance(evidence({ requireBench: true, bench: "inconclusive" })).state).toBe("pending");
    expect(decideAcceptance(evidence({ requireBench: true, bench: "pass" })).state).toBe("accepted");
    expect(decideAcceptance(evidence({ requireBench: true, bench: "fail" }))).toMatchObject({ state: "red", action: "revert" });
  });

  it("waiting ends: past the limit, or after a later release, the repair is inconclusive, never accepted and never reverted", () => {
    const quiet = { bench: "unavailable" as const, recurrence: null };
    expect(decideAcceptance(evidence({ ...quiet, now: 10 + EVIDENCE_WAIT_MS - 1 })).state).toBe("pending");
    const late = decideAcceptance(evidence({ ...quiet, now: 10 + EVIDENCE_WAIT_MS }));
    expect(late).toMatchObject({ state: "inconclusive", action: "none" });
    // 0.1.307 shipped the repair and 0.1.328 runs now: the canary of 0.1.307 is gone, what is measured now is 0.1.328's.
    const later = decideAcceptance(evidence({ deployedVersion: "0.1.307", canary: { version: "0.1.328", tripped: false, windowOpen: false }, supersededBy: "0.1.328", now: 11 }));
    expect(later).toMatchObject({ state: "inconclusive", action: "none" });
    expect(later.reason).toMatch(/0\.1\.328 was released after 0\.1\.307/);
  });
});

describe("the policy gate of a night repair", () => {
  it("an LP-fault repair with the bench proof and a one-step revert is night_decides: the night merges it", () => {
    const change = repairChange(["src/rooms/relay/server/relay.ts", "tests/relay.test.ts"], { benchAvailable: true, rollbackOk: true });
    expect(gateRepair(change)).toMatchObject({ requested: "night_decides", tier: "night_decides", decision: "merge" });
  });

  it("without the bench proof a repair is rejected, never held for the owner", () => {
    expect(gateRepair(repairChange(["src/rooms/relay/server/relay.ts"], { benchAvailable: false, rollbackOk: true }))).toMatchObject({ requested: "night_proposes", decision: "reject" });
  });

  it("a change of the judge merges provisionally and is rejected without its conditions", () => {
    const judge = (files: Parameters<typeof repairChange>[0], benchAvailable = true, rollbackOk = true) => gateRepair(repairChange(files, { benchAvailable, rollbackOk }));
    expect(judge([{ path: "src/rooms/verification/gate-output.ts", status: "M" }, { path: "tests/gate-output-new.test.ts", status: "A" }])).toMatchObject({ tier: "owner_only", decision: "merge", strict: true, provisional: true });
    expect(judge([{ path: "src/rooms/verification/gate-output.ts", status: "M" }, { path: "tests/gate-output.test.ts", status: "M" }]).reason).toMatch(/existing test was changed/);
    expect(judge([{ path: "src/rooms/verification/gate-output.ts", status: "M" }], false)).toMatchObject({ decision: "reject" });
    // A bare path has no known status: a test among them is not proven new.
    expect(judge(["src/rooms/verification/gate-output.ts", "tests/gate-output.test.ts"])).toMatchObject({ decision: "reject" });
  });

  it("availability is recorded as availability: a runnable bench is never a passed one, and a rollback that failed is not a rollback path", () => {
    const change = repairChange([{ path: "src/rooms/verification/gate-output.ts", status: "M" }, { path: "tests/gate-output-new.test.ts", status: "A" }], { benchAvailable: true, rollbackOk: true });
    expect(change.attrs).toMatchObject({ bench_available: true, rollback_path_ok: true });
    const decision = gateRepair(change);
    expect(decision).toMatchObject({ decision: "merge", strict: true, provisional: true });
    expect(decision.reason).toMatch(/accepted only on a passed bench subset/);
    // The old claim alone (the attrs the table asks for) no longer opens the strict path: it is not what the bench or the revert did.
    expect(gateRepair({ ...change, attrs: { bench_subset_passed: true, auto_revertible: true, tests_untouched: true } })).toMatchObject({ decision: "reject" });
    expect(gateRepair(repairChange([{ path: "src/rooms/verification/gate-output.ts", status: "M" }], { benchAvailable: true, rollbackOk: false }))).toMatchObject({ decision: "reject", reason: expect.stringMatching(/revert is not in working order/) });
  });

  it("what the night never does is rejected whatever the proofs", () => {
    expect(gateRepair(repairChange([{ path: "src/rooms/policy/exam.ts", status: "M" }], { benchAvailable: true, rollbackOk: true }))).toMatchObject({ tier: "owner_only", decision: "reject" });
    expect(gateRepair(repairChange([{ path: "src/rooms/policy/exam.ts", status: "M" }], { benchAvailable: true, rollbackOk: true })).reason).toMatch(/never does policy_itself/);
  });
});

describe("the brief a night repair gets", () => {
  const cls = { classKey: "harness:abc123", failureClass: "harness", reasonNorm: "internal_error: another writer integration holds", origin: "harness", counts: [5, 7, 7], windows: [10, 100, 300], recur1: 5, recur7: 9 } as unknown as WallClass;
  const brief = repairBrief({ cls, round: 1, roundsPerNight: 2, role: "engineer", tokenBudget: 4_000_000, hubDb: "/hub/data.db",
    samples: [{ id: "lpattempt_1", state: "blocked", reason: "internal_error: x", project: "proj_1", version: "0.1.268" }] });

  it("carries the samples, the proof, the whole-class sweep, the round cap and the budget", () => {
    expect(brief).toMatch(/lpattempt_1/);
    expect(brief).toContain("regression test that fails without your change");
    expect(brief).toContain(recurrenceSql("harness:abc123"));
    expect(brief).toMatch(/search the repository offline.*every other place/s);
    expect(brief).toContain("SITE: <file>:<line>");
    expect(brief).toMatch(/At most 2 rounds a night/);
    expect(brief).toMatch(/4,000,000 tokens/);
    expect(brief).toMatch(/policy\/\*\*/);
    expect(brief).toContain("NIGHT-REPORT: test=");
  });

  it("reads the sweep back out of the report", () => {
    const report = "done\nSITE: src/a.ts:10 — fixed\nSITE: src/b.ts:4 — fixed\nSITE (not fixed): src/c.ts:9 — needs owner\nNIGHT-REPORT: test=tests/x.test.ts sites=2 class=harness:abc123\nSELF-REPAIR-VERDICT: fixed";
    expect(parseNightReport(report)).toEqual({ sites: 2, sitesOpen: 1, test: "tests/x.test.ts", classKey: "harness:abc123" });
    expect(parseNightReport("nothing")).toEqual({ sites: 0, sitesOpen: 0, test: null, classKey: null });
  });
});

describe("red checks split by side", () => {
  it("Lane Pilot's share of a task class is a class of its own; the writers' keep the old key", async () => {
    const { classKeyOf, wallSignature } = await import("../../src/rooms/wall/signature");
    const sig = wallSignature("validation_failed", "verification failed (cd game && python3 scripts/studio_test.py --filter Par037): exit 1");
    expect(classKeyOf(sig, "writer")).toBe(sig.classKey);
    expect(classKeyOf(sig, "orchestrator")).not.toBe(sig.classKey);
    expect(classKeyOf(sig, "infra")).toBe(classKeyOf(sig, "orchestrator"));
  });
  it("the writers' own red checks are watched, not repaired by the night", async () => {
    const { selectClasses } = await import("../../src/rooms/wall/select");
    const row = (classKey: string, origin: string) => ({ classKey, failureClass: "task", reasonNorm: "verification failed (<check>)", origin, firstSeen: 0, lastSeen: 1, total: 60,
      counts: [5, 30, 60], windows: [10, 100, 500], rung: 0, state: "open", recur7: 60, recur1: 29, failedMoves: 0, hunt: null, afterHuntFailed: 0, stage: "moves" }) as never;
    const picked = selectClasses({ classes: [row("task:writers", "writer"), row("task:lane", "orchestrator")], max: 3, walks: 2, recurrenceFloor: 5,
      openRepair: new Set(), roundsTonight: new Map(), roundsPerNight: 2, tokensLeft: 10_000_000, roundCost: 1_000_000 });
    expect(picked.picked.map((row) => row.classKey)).toEqual(["task:lane"]);
    expect(picked.morning.find((row) => row.classKey === "task:writers")?.why).toMatch(/writers' own red checks/);
  });
});

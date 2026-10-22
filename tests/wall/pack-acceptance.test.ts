import { describe, expect, it } from "vitest";
import { decideAcceptance, gateRepair, repairChange, type AcceptanceEvidence } from "../../src/rooms/wall/acceptance";
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
  canary: { version: "0.1.269", tripped: false, windowOpen: false }, bench: "pass", recurrence: { failures: 0, attempts: 25 }, trainRolledBack: false, ...patch,
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
    expect(decideAcceptance(evidence({ drill: null })).reason).toMatch(/drill/);
    expect(decideAcceptance(evidence({ drill: { version: "0.1.268", at: 20, ok: true } })).state).toBe("pending");
    expect(decideAcceptance(evidence({ canary: { version: "0.1.269", tripped: false, windowOpen: true } })).reason).toMatch(/window is still open/);
    expect(decideAcceptance(evidence({ bench: "pending" })).state).toBe("pending");
  });

  it("red drill: rolled back (the train restores the dist); tripped canary and a worse bench: red with a revert in code", () => {
    expect(decideAcceptance(evidence({ drill: { version: "0.1.269", at: 20, ok: false } }))).toMatchObject({ state: "rolled_back", action: "none" });
    expect(decideAcceptance(evidence({ canary: { version: "0.1.269", tripped: true, windowOpen: false } }))).toMatchObject({ state: "red", action: "revert" });
    expect(decideAcceptance(evidence({ bench: "fail" }))).toMatchObject({ state: "red", action: "revert" });
    expect(decideAcceptance(evidence({ trainRolledBack: true })).state).toBe("rolled_back");
  });

  it("a repair that stays but did not stop the class counts as a failed round; too few attempts prove nothing", () => {
    expect(decideAcceptance(evidence({ recurrence: { failures: 2, attempts: 30 } }))).toMatchObject({ state: "accepted", recurred: true });
    expect(decideAcceptance(evidence({ recurrence: { failures: 2, attempts: 4 } })).recurred).toBe(false);
    expect(decideAcceptance(evidence({ bench: "unavailable" })).checks.find((row) => row.name === "bench subset")!.ok).toBeNull();
  });
});

describe("the policy gate of a night repair", () => {
  it("an LP-fault repair with the bench proof and a one-step revert is night_decides, but only counts once the exam is passed", () => {
    const change = repairChange(["src/rooms/relay/server/relay.ts", "tests/relay.test.ts"], { benchSubset: true, revertible: true });
    const gate = gateRepair(change);
    expect(gate.requested).toBe("night_decides");
    // The committed exam has no unseen decisions yet: the night decides nothing alone.
    expect(gate).toMatchObject({ tier: "night_proposes", degraded: true, decision: "hold" });
    expect(gate.reason).toMatch(/NOT ENOUGH UNSEEN DECISIONS/);
  });

  it("without the bench proof it is a proposal; one that touches the judge or the policy is the owner's", () => {
    expect(gateRepair(repairChange(["src/rooms/relay/server/relay.ts"], { benchSubset: false, revertible: true }))).toMatchObject({ requested: "night_proposes", decision: "hold" });
    expect(gateRepair(repairChange(["src/rooms/verification/gate-output.ts"], { benchSubset: true, revertible: true }))).toMatchObject({ tier: "owner_only", decision: "hold" });
    expect(gateRepair(repairChange(["src/rooms/policy/exam.ts"], { benchSubset: true, revertible: true })).tier).toBe("owner_only");
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

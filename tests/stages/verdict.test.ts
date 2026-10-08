import { describe, expect, it } from "vitest";
import { VERDICT_BLOCK_PREFIX, blockReason, isHardCritical, isVerdictBlockReason, legacyDecisionToStatus, legacySeverityToVerdict, settleVerdict, verdictSchema, verdictSeverityToLegacy } from "../../src/stages/verdict";
import type { Verdict } from "../../src/stages/verdict";

const finding = (over: Record<string, unknown> = {}): never => ({ file: "src/a.ts", line: 12, severity: "high", evidence: "return null; // TODO: implement", ...over }) as never;
const verdict = (status: string, findings: unknown[], over: Record<string, unknown> = {}) => verdictSchema.parse({ status, findings, evidence: "read src/a.ts and the vitest output", ...over });

describe("unified verdict schema", () => {
  it("reads status, findings with file, line, severity and evidence, and the evidence of the verdict", () => {
    const parsed = verdictSchema.parse({ status: "rework", findings: [finding()], evidence: "checked" });
    expect(parsed).toMatchObject({ status: "rework", evidence: "checked" });
    expect(parsed.findings[0]).toMatchObject({ file: "src/a.ts", line: 12, severity: "high" });
  });

  it("rejects an unknown status, an unknown severity, a missing evidence and any other key", () => {
    expect(() => verdictSchema.parse({ status: "approve", findings: [], evidence: "x" })).toThrow();
    expect(() => verdictSchema.parse({ status: "pass", findings: [finding({ severity: "blocking" })], evidence: "x" })).toThrow();
    expect(() => verdictSchema.parse({ status: "pass", findings: [] })).toThrow();
    expect(() => verdictSchema.parse({ status: "pass", findings: [], evidence: "x", extra: 1 })).toThrow();
  });

  it("clips an overlong text instead of failing the answer", () => {
    expect(verdictSchema.parse({ status: "pass", findings: [], evidence: "x".repeat(5000) }).evidence).toHaveLength(4000);
  });
});

describe("old outputs map onto it", () => {
  it("approve is pass, changes_requested is rework, and an old specialist block (a risk the plan must mitigate) is a rework: only the new format can block", () => {
    expect(legacyDecisionToStatus("approve")).toBe("pass");
    expect(legacyDecisionToStatus("changes_requested")).toBe("rework");
    expect(legacyDecisionToStatus("block")).toBe("rework");
  });

  it("blocking, warning and info findings keep their weight both ways", () => {
    expect(legacySeverityToVerdict("blocking")).toBe("high");
    expect(legacySeverityToVerdict("warning")).toBe("medium");
    expect(legacySeverityToVerdict("info")).toBe("info");
    expect(["critical", "high", "medium", "low", "info"].map((s) => verdictSeverityToLegacy(s as never))).toEqual(["blocking", "blocking", "warning", "info", "info"]);
  });
});

describe("the host's reading of a verdict", () => {
  it("a critical or high finding with no line, no file or no quoted evidence does not count", () => {
    const settled = settleVerdict(verdict("rework", [finding({ line: null }), finding({ file: "" }), finding({ evidence: "bad" })]), "code");
    expect(settled.demoted).toBe(3);
    expect(settled.verdict.findings.map((row) => row.severity)).toEqual(["medium", "medium", "medium"]);
    expect(settled.verdict.status).toBe("pass");
  });

  it("a specialist's finding needs a file and evidence, not a line", () => {
    expect(settleVerdict(verdict("block", [finding({ line: undefined, severity: "critical" })]), "specialist")).toMatchObject({ demoted: 0, verdict: { status: "block" } });
  });

  it("a pass that carries a critical or high finding is a rework", () => {
    expect(settleVerdict(verdict("pass", [finding()]), "plan").verdict.status).toBe("rework");
    expect(settleVerdict(verdict("pass", [finding({ severity: "medium" })]), "plan").verdict.status).toBe("pass");
  });

  it("code: a security or destructive critical finding, or more than 5 high, is a block; below that a model's block is a rework; a rework with nothing serious is a pass", () => {
    expect(settleVerdict(verdict("rework", [finding({ severity: "critical", evidence: "const API_KEY = 'sk-live-123456'; // hardcoded secret" })]), "code").verdict.status).toBe("block");
    expect(settleVerdict(verdict("rework", [finding({ severity: "critical", dimension: "security", evidence: "the query is built from the request body" })]), "code").verdict.status).toBe("block");
    expect(settleVerdict(verdict("rework", [finding({ severity: "critical", finding: "the migration drops the orders table on start", impact: "data loss", evidence: "DROP TABLE orders;" })]), "code").verdict.status).toBe("block");
    expect(settleVerdict(verdict("rework", Array.from({ length: 6 }, () => finding())), "code").verdict.status).toBe("block");
    expect(settleVerdict(verdict("block", Array.from({ length: 5 }, () => finding())), "code").verdict.status).toBe("rework");
    expect(settleVerdict(verdict("block", [finding({ severity: "medium" })]), "code").verdict.status).toBe("pass");
    expect(settleVerdict(verdict("rework", [finding({ severity: "medium" })]), "code").verdict.status).toBe("pass");
    expect(settleVerdict(verdict("rework", [finding()]), "code").verdict.status).toBe("rework");
  });

  it("code: a critical unmet or stubbed requirement gets its repair round: rework, also when the model said block or pass", () => {
    const stub = finding({ severity: "critical", finding: "the login handler only logs; acceptance line 2 is unmet" });
    for (const said of ["block", "rework", "pass"]) expect(settleVerdict(verdict(said, [stub]), "code").verdict.status, said).toBe("rework");
    // with a hard critical beside it the task still stops
    expect(settleVerdict(verdict("rework", [stub, finding({ severity: "critical", dimension: "security" })]), "code").verdict.status).toBe("block");
    expect(isHardCritical(stub)).toBe(false);
    expect(isHardCritical(finding({ severity: "high", dimension: "security" }))).toBe(false);
    expect(isHardCritical(finding({ severity: "critical", finding: "edits a file the task forbids (never_touch)" }))).toBe(true);
  });

  it("plan and specialist keep the critic's own block", () => {
    expect(settleVerdict(verdict("block", []), "plan").verdict.status).toBe("block");
    expect(settleVerdict(verdict("block", []), "specialist").verdict.status).toBe("block");
  });
});

describe("the block message for the PM", () => {
  it("names the stage, the summary, the first serious findings and that the task is stopped, not redone", () => {
    const text = blockReason("code-critique", { summary: "The handler is a stub", findings: [finding({ severity: "critical", finding: "login handler only logs" }), finding({ severity: "low" })] });
    expect(text.startsWith(VERDICT_BLOCK_PREFIX + "code-critique: The handler is a stub")).toBe(true);
    expect(text).toContain("src/a.ts:12 [critical] login handler only logs");
    expect(text).not.toContain("[low]");
    expect(text).toContain("stopped, not redone");
    expect(isVerdictBlockReason(text)).toBe(true);
    expect(isVerdictBlockReason("code_critique_blocked")).toBe(false);
  });

  it("stays a sentence of bounded length", () => {
    const long = blockReason("plan-critique", { summary: "s".repeat(900), findings: Array.from({ length: 9 }, () => finding({ finding: "f".repeat(900) })) });
    expect(long.length).toBeLessThan(1100);
  });

  it("the type exported for stage results carries the unified shape", () => {
    const sample: Verdict = { status: "pass", findings: [], evidence: "e" };
    expect(sample.status).toBe("pass");
  });
});

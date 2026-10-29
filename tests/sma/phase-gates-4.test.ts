import { describe, expect, it } from "vitest";
import { approvalSuggestions, excavate, htmlReport } from "../../src/rooms/self-improve";
import {
  GENESIS, acceptanceLines, designGate, partHash, renderBook,
  type BookPart, type Phase, type PhaseRecord, type PlanItem, type TaskFact,
} from "../../src/rooms/phase/logic";

const piece = (id: string): PlanItem => ({
  id, title: id, wave: 1, promise: { given: "g", when: "w", then: "t" },
  task: { id, owns_paths: [`src/${id}.ts`], verification: [{ command: "npm test" }], acceptance: ["works"] },
});

const phase = (record: PhaseRecord): Phase => ({
  id: "ph_1", projectId: "p", pmThreadId: "t", runId: "r", title: "Sums", goal: "sums are right",
  stage: "acceptance", state: "active", record, edition: 1, createdAt: 0, updatedAt: 0,
});

const fact = (extra: Partial<TaskFact> = {}): TaskFact => ({
  taskId: "a", state: "accepted", planFact: "passed", verification: "passed", codeCritique: "passed", ...extra,
});

const line = (id: string, rows: TaskFact) => acceptanceLines(phase({ plan: { items: [piece("a")], sha: "s", admittedSha: "s", contextSha: "c" } }), new Map([["a", rows]]), { mainSha: null, openDeferrals: 0 }).find((row) => row.id === id)!;

const link = (seq: number, prev: string, text: string): BookPart => {
  const row = { seq, at: 1, section: "goal" as const, kind: "opened", text, prevHash: prev };
  return { ...row, hash: partHash(prev, row) };
};

describe("phase gates", () => {
  it("[sma:p3_not_needed] records that no drawing is needed and lets the gate open", () => {
    expect(designGate({ design: { decision: "not_needed", why: "no piece changes a screen" } }).ok).toBe(true);
  });

  it("[sma:p3_awaiting] holds a reviewed drawing until the owner says so", () => {
    const drawing = { paths: [".agents/phases/ph_1/design/UI-SPEC.md"], sha256: "d", designer: "design-lead", reviewer: "ui-review", feasible: true };
    const held = designGate({ ownerWords: true, design: { decision: "needed", why: "screens", drawing } });
    expect(held.ok).toBe(false);
    if (!held.ok) expect(held.why.join(" ")).toContain("awaits the owner's word");
  });

  it("[sma:p4_qa] a planned browser check that has not passed is not a pass", () => {
    expect(line("qa_read", fact({ qaPlanned: true, browserQa: null })).ok).toBe(false);
    expect(line("qa_read", fact({ qaPlanned: true, browserQa: null })).detail).toContain("has not passed");
    expect(line("qa_read", fact({ qaPlanned: true, browserQa: "failed" })).detail).toContain("browser check failed");
    expect(line("qa_read", fact({ qaPlanned: true, browserQa: "passed" })).ok).toBe(true);
    expect(line("qa_read", fact()).detail).toContain("plan none");
  });

  it("[sma:pc_book] re-reads the phase book, and a rewritten part breaks the chain", () => {
    const first = link(1, GENESIS, "phase opened");
    const second = link(2, first.hash, "context signed");
    const shown = phase({});
    expect(renderBook(shown, [first, second])).toContain("intact (2 parts)");
    expect(renderBook(shown, [first, second])).toContain("sums are right");
    expect(renderBook(shown, [first, { ...second, text: "rewritten" }])).toContain("BROKEN at part 2");
  });

  it("[sma:k_v_approvals] suggests a rule the owner repeated three times and applies nothing", () => {
    const once = { descriptor: { kind: "merge" }, expected: "yes" };
    expect(approvalSuggestions([once, once])).toEqual([]);
    const suggested = approvalSuggestions([once, once, once]);
    expect(suggested).toEqual([{ pattern: "merge→yes", times: 3, suggestion: "the owner decided merge→yes 3 times: let the night policy decide it the same way" }]);
    expect(suggested[0]).not.toHaveProperty("enabled");
  });

  it("[sma:k_v_excavate] [sma:k_lib_excavate] keeps a fix from a foreign history and drops a feature commit", () => {
    const found = excavate(["\u0001abcdef1234567890\u0002fix the crash", "src/a.ts", "\u0001def4567890123456\u0002add a screen", "src/b.ts"].join("\n"));
    expect(found).toEqual([{ commit: "abcdef123456", subject: "fix the crash", files: ["src/a.ts"] }]);
  });

  it("[sma:k_v_metrics] writes the numbers into one page and escapes what a row contains", () => {
    const page = htmlReport({ title: "SMA", sections: [{ heading: "spend", rows: [{ project: "projA", note: "<script>" }] }] });
    expect(page).toContain("<h1>SMA</h1>");
    expect(page).toContain("projA");
    expect(page).toContain("&lt;script&gt;");
    expect(page).not.toContain("<script>");
  });

  it.todo("[sma:px_return_exec] a return to execution queues the piece one attempt higher — returnTo only withdraws the later stage"); // deferral:dfr_seed_skip_sma_gaps
});

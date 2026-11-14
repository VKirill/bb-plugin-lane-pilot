import { describe, expect, it } from "vitest";
import { parseCodeCritique } from "../../src/rooms/critique/code-critique";
import { parseVerifierAnswer, seriousFindings, verifierPrompt } from "../../src/rooms/critique/code-verifier";
import { verifySeriousFindings } from "../../src/rooms/critique/server/critique-runs/verify-findings";
import type { CriticCatalog } from "../../src/rooms/critique/critic-pair";

const GEMINI = "router9/ag/gemini-3.8-flash-high";
const critic = { providerId: "opencode2", model: GEMINI };
const catalog = (spec: Record<string, Record<string, string[]>>): CriticCatalog => ({
  provider: async (providerId) => spec[providerId] ? { id: providerId, available: true, supportsServiceTier: false, serviceTiers: [] } : null,
  models: async (providerId) => Object.entries(spec[providerId] ?? {}).map(([model, efforts]) => ({ id: model, model, efforts })),
});
const offered = catalog({ codex: { "gpt-6.1-sol": ["medium"] }, opencode2: { [GEMINI]: ["medium"] } });
const finding = (id: string, file: string, severity: string) => ({ id, file, line: 10, severity, criterion: `${id}-criterion`, finding: `${id} is broken`, evidence: `const x = unsafe(${id}); // at ${file}` });
const critiqueOf = (findings: unknown[], status = "rework") => parseCodeCritique(JSON.stringify({ status, summary: "s", findings, evidence: "read the diff" }));

describe("the verifier of a strict code critique", () => {
  it("drops a refuted finding to medium, keeps confirmed and unsure, and records the counts", async () => {
    const critique = critiqueOf([finding("a", "src/a.ts", "high"), finding("b", "src/b.ts", "critical"), finding("c", "src/c.ts", "high"), finding("d", "src/d.ts", "medium")]);
    const asked = seriousFindings(critique).map((row) => row.id);
    expect(asked).toHaveLength(3);
    let prompt = ""; let pair = "";
    const out = await verifySeriousFindings({ critique, critic, effort: "medium", tier: "standard", catalog: offered, task: { id: "t" }, run: async (text, to) => {
      prompt = text; pair = `${to.providerId}/${to.model}`;
      return `reading the files\n${JSON.stringify({ verdicts: [
        { id: asked[0], verdict: "refuted", evidence: "src/a.ts:8 guards the value before the call" },
        { id: asked[1], verdict: "confirmed", evidence: "src/b.ts:10 no guard" },
        { id: asked[2], verdict: "unsure", evidence: "" }] })}`;
    } });
    expect(pair).toBe("codex/gpt-6.1-sol");
    expect(prompt).toContain("FINDINGS:");
    expect(prompt).toContain("src/a.ts");
    expect(prompt).not.toContain("src/d.ts");
    expect(out.outcome).toMatchObject({ model: "codex/gpt-6.1-sol", confirmed: 1, refuted: 1, unsure: 1 });
    const byId = new Map(out.critique.findings.map((row) => [row.id, row.severity]));
    expect(byId.get(asked[0]!)).toBe("warning");
    expect(byId.get(asked[1]!)).toBe("blocking");
    expect(byId.get(asked[2]!)).toBe("blocking");
    expect(out.critique.verdict?.findings.find((row) => row.file === "src/a.ts")?.severity).toBe("medium");
    expect(out.critique.status).toBe("rework");
    expect(out.outcome && "findings" in out.outcome ? out.outcome.findings[0]!.evidence : "").toContain("guards the value");
  });

  it("passes the critique when every serious finding is refuted", async () => {
    const critique = critiqueOf([finding("a", "src/a.ts", "high")]);
    const [row] = seriousFindings(critique);
    const out = await verifySeriousFindings({ critique, critic, effort: "medium", tier: "standard", catalog: offered, task: {}, run: async () => JSON.stringify({ verdicts: [{ id: row!.id, verdict: "refuted", evidence: "covered by src/guard.ts:4" }] }) });
    expect(out.critique.status).toBe("pass");
    expect(out.critique.decision).toBe("approve");
    expect(out.critique.findings[0]!.severity).toBe("warning");
  });

  it("keeps the critic's verdict when the verifier fails, answers nonsense or times out", async () => {
    const critique = critiqueOf([finding("a", "src/a.ts", "high")]);
    for (const run of [async () => { throw new Error("critique_thread_timeout"); }, async () => "no json here", async () => JSON.stringify({ verdicts: [{ id: "unknown", verdict: "refuted", evidence: "x" }] })]) {
      const out = await verifySeriousFindings({ critique, critic, effort: "medium", tier: "standard", catalog: offered, task: {}, run });
      expect(out.critique).toBe(critique);
      expect(out.critique.status).toBe("rework");
    }
    const failed = await verifySeriousFindings({ critique, critic, effort: "medium", tier: "standard", catalog: offered, task: {}, run: async () => { throw new Error("critique_thread_timeout"); } });
    expect(failed.outcome).toEqual({ failed: "critique_thread_timeout" });
  });

  it("makes no call without a serious finding or without a model of another family on offer", async () => {
    let calls = 0;
    const run = async () => { calls++; return "{}"; };
    const none = await verifySeriousFindings({ critique: critiqueOf([finding("m", "src/m.ts", "medium")], "pass"), critic, effort: "medium", tier: "standard", catalog: offered, task: {}, run });
    expect(none.outcome).toBeNull();
    const alone = await verifySeriousFindings({ critique: critiqueOf([finding("a", "src/a.ts", "high")]), critic, effort: "medium", tier: "standard", catalog: catalog({ opencode2: { [GEMINI]: ["medium"] } }), task: {}, run });
    expect(alone.outcome).toEqual({ skipped: "no_other_family_offered" });
    expect(calls).toBe(0);
  });

  it("reads the answer and builds the prompt", () => {
    expect(parseVerifierAnswer('{"verdicts":[{"id":"a","verdict":"confirmed","evidence":"e"},{"id":"a","verdict":"refuted","evidence":"dup"},{"id":"z","verdict":"refuted","evidence":"x"}]}', ["a"])).toEqual([{ id: "a", verdict: "confirmed", evidence: "e" }]);
    expect(verifierPrompt({ findings: [], task: {}, workspace: "/repo" })).toContain("in /repo");
  });
});

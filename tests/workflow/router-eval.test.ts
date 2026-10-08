import { describe, expect, it } from "vitest";
import { MIN_CONFIDENCE, routeIntent } from "../../src/workflow/router";
import { publishedCatalog, realCatalog } from "./router-catalog";
import { EVAL_SET, HELD_OUT_SET, RESERVE_SET } from "./router-eval-set";

const outcome = async (phrase: string) => {
  const decision = await routeIntent({ intent: phrase, workflows: publishedCatalog() });
  return { decision, id: decision.workflowId ?? "clarify" };
};

describe("router evaluation set (chains spec 6.2)", () => {
  it("picks the expected workflow for at least 27 of the 30 phrases with the deterministic scorer", async () => {
    const rows: Array<{ n: number; expected: string; got: string; confidence: number; top: string }> = [];
    for (const [n, phrase, expected] of EVAL_SET) {
      const { decision, id } = await outcome(phrase);
      rows.push({ n, expected, got: id, confidence: decision.confidence, top: decision.candidates.slice(0, 3).map((c) => `${c.id}:${c.score.toFixed(2)}`).join(" ") });
    }
    const wrong = rows.filter((row) => row.got !== row.expected);
    const correct = rows.length - wrong.length;
    if (process.env.ROUTER_EVAL_VERBOSE || wrong.length > 3) console.log(`router eval ${correct}/30\n${rows.map((r) => `${r.n}. ${r.got === r.expected ? "ok " : "BAD"} expected ${r.expected} got ${r.got} (${r.confidence}) ${r.top}`).join("\n")}`);
    expect(correct).toBeGreaterThanOrEqual(27);
    // The clarify phrase never starts anything.
    expect(rows.find((row) => row.n === 30)).toMatchObject({ got: "clarify" });
    expect(rows.find((row) => row.n === 30)!.confidence).toBeLessThan(MIN_CONFIDENCE);
  });

  it("keeps the right workflow in the top 5 before the choice (recall at 5)", async () => {
    const missed: number[] = [];
    for (const [n, phrase, expected] of EVAL_SET.filter(([, , id]) => id !== "clarify")) {
      const { decision } = await outcome(phrase);
      if (!decision.candidates.some((candidate) => candidate.id === expected)) missed.push(n);
    }
    expect(missed.length).toBeLessThanOrEqual(1);
  });

  it("routes the reserve phrases (single-step chains) on the same scorer", async () => {
    const rows: string[] = [];
    let correct = 0;
    for (const [phrase, expected] of RESERVE_SET) {
      const { id, decision } = await outcome(phrase);
      if (id === expected) correct += 1;
      else rows.push(`${phrase} -> ${id} (expected ${expected}) ${decision.candidates.slice(0, 3).map((c) => `${c.id}:${c.score.toFixed(2)}`).join(" ")}`);
    }
    if (process.env.ROUTER_EVAL_VERBOSE || rows.length > 2) console.log(`reserve ${correct}/${RESERVE_SET.length}\n${rows.join("\n")}`);
    expect(correct).toBeGreaterThanOrEqual(6);
  });

  it("also routes most of the held-out paraphrases", async () => {
    const rows: string[] = [];
    let correct = 0;
    for (const [phrase, expected] of HELD_OUT_SET) {
      const { id, decision } = await outcome(phrase);
      if (id === expected) correct += 1;
      else rows.push(`${phrase} -> ${id} (expected ${expected}, ${decision.confidence}) ${decision.candidates.slice(0, 3).map((c) => `${c.id}:${c.score.toFixed(2)}`).join(" ")}`);
    }
    if (process.env.ROUTER_EVAL_VERBOSE) console.log(`held-out ${correct}/${HELD_OUT_SET.length}\n${rows.join("\n")}`);
    expect(correct / HELD_OUT_SET.length).toBeGreaterThanOrEqual(0.75);
  });

  it("never lists an eval phrase among the catalog examples", () => {
    const examples = new Set(publishedCatalog().flatMap((workflow) => [...workflow.examples.en, ...workflow.examples.ru]).map((text) => text.trim().toLowerCase()));
    for (const [, phrase] of EVAL_SET) expect(examples.has(phrase.trim().toLowerCase())).toBe(false);
    for (const [phrase] of RESERVE_SET) expect(examples.has(phrase.trim().toLowerCase())).toBe(false);
  });
});

describe("the router on the catalog as it ships (audit 2026-10-08, item 9)", () => {
  const real = realCatalog();
  const ask = (phrase: string, workflows = real) => routeIntent({ intent: phrase, workflows });

  it("offers the tested chains instead of hiding them: 27 or more of the 30 phrases, the held-out and the reserve ones too", async () => {
    expect(real.filter((workflow) => workflow.status === "tested" && !workflow.internal).map((workflow) => workflow.id).sort())
      .toEqual(["about-site", "deploy", "insights-post", "invoice-send", "reels", "resume", "seo-cocoon", "web-research", "x-to-telegram-digest", "year-review"]);
    const wrong: string[] = [];
    for (const [n, phrase, expected] of EVAL_SET) { const decision = await ask(phrase); if ((decision.workflowId ?? "clarify") !== expected) wrong.push(`${n} ${expected} <- ${decision.workflowId ?? "clarify"} (${decision.confidence})`); }
    expect(30 - wrong.length, wrong.join("; ")).toBeGreaterThanOrEqual(27);
    let held = 0;
    for (const [phrase, expected] of HELD_OUT_SET) if ((await ask(phrase)).workflowId === expected) held += 1;
    expect(held / HELD_OUT_SET.length).toBeGreaterThanOrEqual(0.9);
    let reserve = 0;
    for (const [phrase, expected] of RESERVE_SET) if (((await ask(phrase)).workflowId ?? "clarify") === expected) reserve += 1;
    expect(reserve).toBeGreaterThanOrEqual(7);
  });

  it("a tested chain is chosen with the «not yet run live» flag and a warning; a published one is not flagged", async () => {
    const tested = await ask("Нужен кокон страниц для интернет-магазина чая, с исследованием аудитории");
    expect(tested).toMatchObject({ decision: "route", workflowId: "seo-cocoon", liveTrial: true });
    expect(tested.candidates[0]).toMatchObject({ id: "seo-cocoon", liveTrial: true });
    expect(tested.warnings.join(" ")).toContain("has not run for real yet");
    const published = await ask("Implement dark mode toggle in the settings screen");
    expect(published).toMatchObject({ workflowId: "analyze-plan-execute", liveTrial: false });
    expect(published.warnings.join(" ")).not.toContain("not run for real");
  });

  it("does not trust a neighbour when the chain the rules point at is not offered: asks instead of answering ui-audit at 99", async () => {
    const withoutCocoon = real.map((workflow) => (workflow.id === "seo-cocoon" ? { ...workflow, status: "draft" as const } : workflow));
    const decision = await ask("Нужен кокон страниц для интернет-магазина чая, с исследованием аудитории", withoutCocoon);
    expect(decision.decision).toBe("clarify");
    expect(decision.workflowId).toBeNull();
    expect(decision.warnings.join(" ")).toContain("seo-cocoon is not available");
    // Another request is not touched by it.
    expect((await ask("Implement dark mode toggle in the settings screen", withoutCocoon)).workflowId).toBe("analyze-plan-execute");
  });

  it("every phrase of the three sets is routed on the shipped statuses with a confident answer only when it is right", async () => {
    const confidentMisses: string[] = [];
    for (const [n, phrase, expected] of EVAL_SET) { const d = await ask(phrase); if (d.workflowId && d.workflowId !== expected && d.confidence >= 90) confidentMisses.push(`${n}:${d.workflowId}`); }
    expect(confidentMisses).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { out, pathOf } from "./chain-helpers";
import { runSim } from "./chain-harness";

/**
 * about-site, resume and year-review on stubs (A8): the public facts, the writing agent and the file save answer from stubs; the
 * routing, the check loop and the emits are the real engine's. The facts action itself (public-only, confirmed-only) and the check
 * are tested against the real store in tests/anamnesis/chain-actions.test.ts.
 */
const CHAINS = [
  { id: "about-site", input: { language: "ru" }, field: "site_path" },
  { id: "resume", input: { language: "en", notes: "marketing roles" }, field: "resume_path" },
  { id: "year-review", input: { year: 2026, language: "ru" }, field: "review_path" },
] as const;
const facts = { text: "## Projects (1)\n- Lane Pilot", records: 3, empty: false };

describe.each(CHAINS)("$id", ({ id, input, field }) => {
  it("writes from the public facts, checks the text and saves it once", async () => {
    const stubs = { facts, write: { artifact: "the text" }, check: { ok: true, violations: [] }, deliver: { [field]: `.lane-pilot/anamnesis/${id}-2026-10-08/` } };
    // The literal ids are what tests/workflow/chains-status.test.ts looks for: every built-in chain has a test case.
    const r = id === "about-site" ? await runSim("about-site", { input, stubs }) : id === "resume" ? await runSim("resume", { input, stubs }) : await runSim("year-review", { input, stubs });
    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("facts write check deliver done");
    expect(out(r)).toMatchObject({ status: "done", [field]: `.lane-pilot/anamnesis/${id}-2026-10-08/`, records: 3 });
    expect(r.called("deliver")).toHaveLength(1);
    // The writer gets the facts and the owner's wishes, not the store.
    expect(r.called("write")[0]!.input).toMatchObject({ facts_text: facts.text, language: input.language });
  });

  it("with nothing public the chain says so and writes nothing", async () => {
    const r = await runSim(id, { input, stubs: { facts: { text: "Nothing recorded yet.", records: 0, empty: true } } });
    expect(pathOf(r)).toBe("facts nothing_public");
    expect(r.called("write")).toHaveLength(0);
    expect(r.called("deliver")).toHaveLength(0);
    expect(out(r)).toMatchObject({ status: "nothing_public", records: 0 });
    expect(String(out(r)!.reason)).toContain("marked public");
  });

  it("a text that fails the check is written again once with the violations, then saved", async () => {
    const r = await runSim(id, { input, stubs: {
      facts, write: [{ artifact: "bad: https://invented.example" }, { artifact: "good" }],
      check: [{ ok: false, violations: ["url_unknown:https://invented.example"] }, { ok: true, violations: [] }],
      deliver: { [field]: "p" },
    } });
    expect(pathOf(r)).toBe("facts write check write check deliver done");
    expect(r.called("write")[1]!.input).toMatchObject({ fix: ["url_unknown:https://invented.example"] });
    expect(out(r)).toMatchObject({ status: "done" });
  });

  it("a text that fails the check twice is not saved", async () => {
    const r = await runSim(id, { input, stubs: { facts, write: { artifact: "bad" }, check: { ok: false, violations: ["draft_mark"] } } });
    expect(pathOf(r)).toBe("facts write check write check blocked");
    expect(r.called("deliver")).toHaveLength(0);
    expect(out(r)).toMatchObject({ status: "blocked", [field]: "" });
  });
});

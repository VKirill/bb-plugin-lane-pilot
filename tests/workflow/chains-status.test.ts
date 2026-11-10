import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chainStore } from "./chain-harness";

/**
 * A built-in chain is `published` only when its test case passes on stubs: the cases are the `runSim("<id>", ...)` calls of
 * chains-*.test.ts (the pipeline `lp-task-pipeline` has the engine-on/engine-off equivalence test instead). The owner's own chains
 * need tools the test machine does not have, so they stay `tested` with a note about what is not live yet.
 */
const dir = __dirname;
const sources = readdirSync(dir).filter((name) => /^chains-.*\.test\.ts$/.test(name) && name !== "chains-status.test.ts").map((name) => readFileSync(join(dir, name), "utf8")).concat(readFileSync(join(dir, "../sma/parity-d4-workflows-b-2.test.ts"), "utf8")).join("\n");
const withCase = new Set([...sources.matchAll(/runSim\("([a-z0-9][a-z0-9.-]*)"/g)].map((match) => match[1]!));
const OWN = ["about-site", "deploy", "insights-post", "invoice-send", "reels", "resume", "seo-cocoon", "web-research", "x-to-telegram-digest", "year-review"];

describe("status of the built-in chains", () => {
  it("every chain of the catalog has a test case, and published means its case is there", async () => {
    const store = await chainStore();
    const missing: string[] = [];
    for (const item of store.list()) {
      const id = item.workflow.id;
      // The body of a schedule of kind agent: its case is in tests/schedule/agent-routine.test.ts, run through the real engine. A starter graph
      // (`startedBy`: lp-task-pipeline, errand) is run by the tool that starts it, with its own test file (tests/errand-graph.test.ts).
      // The lead's tick (lead-tick): its case is tests/lead/tick.test.ts (runSim on stubs), next to the code steps it drives.
      if (item.workflow.startedBy || id === "agent-routine" || id === "lead-tick") continue;
      if (!withCase.has(id)) missing.push(id);
    }
    expect(missing).toEqual([]);
  });

  it("the owner's own chains are tested with a note, everything else that is built in is published", async () => {
    const store = await chainStore();
    for (const item of store.list()) {
      const { id, status } = item.workflow;
      if (OWN.includes(id)) {
        expect(status, id).toBe("tested");
        expect((item.workflow.test as { note?: string } | undefined)?.note, id).toContain("Not live yet");
      } else expect(status, id).toBe("published");
    }
  });

  it("the catalog has the 15 chains, 9 single-step chains, 7 own chains and 9 fragments (the spec's 7, lp.draw, the phase drawing, and telegram-send, the shared Telegram send)", async () => {
    const store = await chainStore();
    const ids = store.list().map((item) => item.workflow.id);
    expect(ids).toEqual(expect.arrayContaining(["analyze-plan-execute", "full-lifecycle", "refactor", "review-fix", "quality-loop", "issue-full", "issue-quick", "grill-driven", "brainstorm-driven", "roadmap-driven", "blueprint-driven", "impeccable-build", "debug", "companion", "milestone-close"]));
    expect(ids).toEqual(expect.arrayContaining(["analyze-code", "plan-only", "code-review", "grill-plan", "test-gen", "security-audit", "issue-discover", "retrospective", "ui-audit"]));
    expect(ids).toEqual(expect.arrayContaining(OWN));
    expect(ids.filter((id) => store.get(id)!.workflow.internal).sort()).toEqual(["ins.post", "lp.analyze", "lp.brainstorm", "lp.build", "lp.close", "lp.draw", "lp.plan", "lp.review", "telegram-send"]);
    expect(ids).toEqual(expect.arrayContaining(["validate-phase", "eval-review", "ai-integration-phase", "spike", "ship", "pr-branch", "cleanup", "new-milestone", "plan-review-convergence", "project-start"]));
    expect(ids).toEqual(expect.arrayContaining(["3d-asset", "roblox-asset", "social-post"]));
    expect(ids).toEqual(expect.arrayContaining(["research-dossier", "billing-batch", "macos-routine", "seo-page", "api-recon"]));
    // SEO wave 1: the intake and the monitor are chains; the research, the brief and the release are called by other graphs.
    expect(ids).toEqual(expect.arrayContaining(["seo-project-intake", "seo-monitor", "seo-research", "seo-brief", "seo-release"]));
    // SEO wave 2: the drop diagnosis is called by the monitor; the audits and the refresh are chains and monitor follow-ups.
    expect(ids).toEqual(expect.arrayContaining(["seo-drop-diagnosis", "seo-tech-audit", "seo-page-refresh", "seo-structure-audit"]));
    expect(ids).toEqual(expect.arrayContaining(["seo-template-scale", "seo-trust"]));
    // SEO wave 3b: the link program is a chain; outreach and mentions are subworkflows it calls.
    expect(ids).toEqual(expect.arrayContaining(["seo-linkbuilding", "seo-outreach", "seo-mentions"]));
    expect(ids).toHaveLength(112); // +8 SMA command workflows (milestone-summary, mvp-phase, note-add, phase-assumptions, profile-user, secure-phase, spec-phase, todo-add, +2 d5-phase-2 (backlog-add, plan-import); their cases are in tests/sma/parity-d4-workflows-b-2.test.ts), +1 lp.clarify (clarifying questions before a plan, SMA m_sg_clarify), +1 idea-shootdown (EGM brainstorm-only), +1 lp.episodes (stage 1 R5), +5 seo wave-1, +4 wave-2, +5 wave-3 (template-scale, trust, linkbuilding, outreach, mentions)
  });
});

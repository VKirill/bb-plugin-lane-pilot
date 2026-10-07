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
const sources = readdirSync(dir).filter((name) => /^chains-.*\.test\.ts$/.test(name) && name !== "chains-status.test.ts").map((name) => readFileSync(join(dir, name), "utf8")).join("\n");
const withCase = new Set([...sources.matchAll(/runSim\("([a-z][a-z0-9.-]*)"/g)].map((match) => match[1]!));
const OWN = ["deploy", "insights-post", "reels", "seo-cocoon", "web-research", "x-to-telegram-digest"];

describe("status of the built-in chains", () => {
  it("every chain of the catalog has a test case, and published means its case is there", async () => {
    const store = await chainStore();
    const missing: string[] = [];
    for (const item of store.list()) {
      const id = item.workflow.id;
      if (id === "lp-task-pipeline") continue;
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

  it("the catalog has the 15 chains, 9 single-step chains, 6 own chains and 7 fragments of the spec", async () => {
    const store = await chainStore();
    const ids = store.list().map((item) => item.workflow.id);
    expect(ids).toEqual(expect.arrayContaining(["analyze-plan-execute", "full-lifecycle", "refactor", "review-fix", "quality-loop", "issue-full", "issue-quick", "grill-driven", "brainstorm-driven", "roadmap-driven", "blueprint-driven", "impeccable-build", "debug", "companion", "milestone-close"]));
    expect(ids).toEqual(expect.arrayContaining(["analyze-code", "plan-only", "code-review", "grill-plan", "test-gen", "security-audit", "issue-discover", "retrospective", "ui-audit"]));
    expect(ids).toEqual(expect.arrayContaining(OWN));
    expect(ids.filter((id) => store.get(id)!.workflow.internal).sort()).toEqual(["ins.post", "lp.analyze", "lp.brainstorm", "lp.build", "lp.close", "lp.plan", "lp.review"]);
    expect(ids).toHaveLength(38);
  });
});

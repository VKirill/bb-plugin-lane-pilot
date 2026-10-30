import { describe, expect, it } from "vitest";
import { advisoryCritiqueLine, loadSealedSet } from "../../src/rooms/bench/critique-set";
import { benchWorld } from "./helpers";
import { getSet } from "../../src/rooms/bench/store";
import manifest from "../../bench/real-prs-v1.json";

describe("advisory bench set: real-prs-v1 (S4)", () => {
  it("ships 10-20 real commits, each with a diff and a known outcome", () => {
    expect(manifest.tasks.length).toBeGreaterThanOrEqual(10);
    expect(manifest.tasks.length).toBeLessThanOrEqual(20);
    const outcomes = new Set(manifest.tasks.map((t) => t.outcome));
    expect(outcomes.has("accepted")).toBe(true);
    expect(outcomes.has("reverted") || outcomes.has("fixed_after")).toBe(true);
    for (const t of manifest.tasks) {
      expect(t.taskId).toMatch(/^[0-9a-f]{8}$/);
      expect(t.diff.length).toBeGreaterThan(10);
      if (t.outcome !== "accepted") expect(t.expected_findings?.length).toBeGreaterThan(0);
    }
  });

  it("loads like the other sealed sets and keeps the outcome in the contract", () => {
    const { db } = benchWorld();
    const set = loadSealedSet(db, { version: manifest.version, manifest: manifest as never });
    expect(set.taskCount).toBe(manifest.tasks.length);
    const stored = getSet(db, manifest.version)!;
    expect(stored.tasks.filter((t) => (t.contract as { outcome?: string }).outcome !== "accepted").length).toBe(3);
  });

  it("scores caught bad PRs and false alarms on clean ones", () => {
    const { db } = benchWorld();
    loadSealedSet(db, { version: "v-adv", manifest: manifest.tasks.slice(0, 5) as never });
    const tasks = getSet(db, "v-adv")!.tasks;
    // 4d176079 bad (threads.get), ebbda4af bad (narrow_brief), 92e6914e bad (sealed), then two clean.
    const receipts = (taskId: string) => ({
      "4d176079": { findings: [{ file: "src/rooms/workflow/server/workflow-agent.ts", finding: "unguarded threads.get throws when the stub lacks it", severity: "high" }] },
      "ebbda4af": { findings: [{ file: "src/rooms/writer/server/start.ts", finding: "narrow_brief replaces the original failure reason", severity: "medium" }] },
      "92e6914e": { findings: [] },
      "b490888e": { findings: [{ file: "src/rooms/bench/server/weekly.ts", finding: "schedule would still exceed the cap", severity: "critical" }] },
      "61efa939": { findings: [{ file: "x.ts", finding: "nit: naming", severity: "low" }] },
    })[taskId as never];
    const score = advisoryCritiqueLine(tasks, (id) => receipts(id));
    expect(score).toMatchObject({ caught: 2, bad: 3, falseAlarms: 1, clean: 2 });
    expect(score.line).toBe("advisory critique: caught 2/3 bad PRs, 1 false alarm on 2 clean PRs");
    expect(advisoryCritiqueLine([], () => null).line).toBeNull();
  });
});

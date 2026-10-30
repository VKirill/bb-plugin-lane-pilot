import { describe, expect, it } from "vitest";
import { parseWorkflow } from "@lane-pilot/workflow-engine";
import type { GoalAudit, RunGoal } from "@lane-pilot/workflow-engine";
import { engineOn, journalDb, ok } from "./engine-helpers";

const GOAL: RunGoal = { id: "request", done_when: "The button is blue", evidence: "the checks are green", guess: true };

const chain = parseWorkflow({
  id: "tiny-goal",
  name: { en: "Tiny goal", ru: "Мелкая цель" },
  description: { en: "A fixture", ru: "Заглушка" },
  goal_audit: "required",
  inputs: { size: "string", writer_state: "string?", already_met: "bool?" },
  outputs: { status: "string" },
  entry: "class",
  nodes: [
    { id: "class", type: "action", action: "mark", out: { size: "tiny|small|large" } },
    { id: "plan", type: "action", action: "mark", out: { tasks: "object[]", task_count: "number", already_met: "bool" } },
    { id: "write", type: "action", action: "mark", out: { state: "accepted|blocked" } },
    { id: "closed", type: "action", action: "emit", map: { status: "closed" } },
  ],
  edges: [
    { from: "class", to: "plan" },
    { from: "plan", to: "write" },
    { from: "write", to: "closed" },
  ],
});

function run(inputs: Record<string, unknown>) {
  const db = journalDb();
  const seen: Array<{ output: Record<string, unknown> }> = [];
  const engine = engineOn(db, {
    mark: ok((ctx) => {
      if (ctx.nodeId === "class") return { size: String(ctx.inputs.size ?? "tiny") };
      if (ctx.nodeId === "plan") return {
        tasks: [{ id: "t1", acceptance: ["npx vitest run tests/a.test.ts"] }],
        task_count: ctx.inputs.already_met === true ? 0 : 1,
        already_met: ctx.inputs.already_met === true,
      };
      return { state: String(ctx.inputs.writer_state ?? "accepted") };
    }),
  }, {
    auditGoals: async (input): Promise<GoalAudit> => {
      seen.push({ output: input.output });
      return { met: ["request"], unmet: [] };
    },
  });
  return { engine, seen, started: engine.start({ workflow: chain, inputs, goals: [GOAL] }) };
}

describe("a tiny closed run is judged by code", () => {
  it("does not call the auditor when the writer accepted and the task has acceptance", async () => {
    const { seen, started } = run({ size: "tiny" });
    expect(await started.done).toMatchObject({ status: "succeeded" });
    expect(seen).toEqual([]);
  });

  it("does not call the auditor when the plan already met the goal, and blocks a closed tiny run whose checks are not green", async () => {
    const already = run({ size: "tiny", already_met: true, writer_state: "blocked" });
    expect(await already.started.done).toMatchObject({ status: "succeeded" });
    expect(already.seen).toEqual([]);
    const red = run({ size: "tiny", writer_state: "blocked" });
    expect(await red.started.done).toMatchObject({ status: "blocked" });
    expect(red.seen).toEqual([]);
  });

  it("still asks the auditor when the class is small", async () => {
    const { seen, started } = run({ size: "small" });
    expect(await started.done).toMatchObject({ status: "succeeded" });
    expect(seen).toHaveLength(1);
  });
});

import { describe, expect, it } from "vitest";
import { parsePrediction, predictionHeld } from "../src/rooms/wall/brief";
import { decideTrial } from "../src/rooms/harness/server/trial";
import type { ArmAttempt } from "../src/rooms/harness/server/store";

const report = `... sites done\n\`\`\`prediction\n{"fixes_class":"harness:timeout","must_not_move":["acceptance","src/rooms/wall/service.ts"]}\n\`\`\``;

describe("repair prediction (C3)", () => {
  it("the report's prediction block parses; the check reads the deployed evidence", () => {
    expect(parsePrediction(report)).toEqual({ fixes_class: "harness:timeout", must_not_move: ["acceptance"], unknown: ["src/rooms/wall/service.ts"] });
    // A name outside the metric list is dropped and marked, so a prediction of only made-up names checks nothing silently.
    const junk = parsePrediction("```prediction\n{\"must_not_move\":[\"src/x.ts\",\"coverage\"]}\n```");
    expect(junk).toEqual({ fixes_class: null, must_not_move: [], unknown: ["src/x.ts", "coverage"] });
    expect(parsePrediction("no block here")).toBeNull();
    const ok = predictionHeld({ fixes_class: "c", must_not_move: ["acceptance"] }, { recurred: false, benchScore: 0.7, baselineScore: 0.6 });
    expect(ok.held).toBe(true);
    expect(predictionHeld({ fixes_class: "c", must_not_move: ["acceptance"] }, { recurred: true }).held).toBe(false);
    expect(predictionHeld({ fixes_class: "c", must_not_move: ["acceptance"] }, { recurred: false, benchScore: 0.4, baselineScore: 0.6 }).held).toBe(false);
  });
});

describe("trial prediction", () => {
  const row = (arm: ArmAttempt["arm"], state: string, attemptNo = 1, blocking = 0): ArmAttempt => ({ arm, taskId: `${arm}${attemptNo}`, attemptId: `${arm}-${attemptNo}`, createdAt: attemptNo, attemptNo, state, blockingFindings: blocking });
  const rows: ArmAttempt[] = [
    ...[1, 2, 3, 4, 5, 6].flatMap((n) => [row("new", "accepted", n), row("old", "accepted", n)]),
  ];
  it("a prediction whose must_not_move moved retires the tree; a kept one keeps the live decision", () => {
    const base = decideTrial(rows, 0, 86_400_000);
    expect(base.action).toBe("retire"); // equal arms, no measurable gain
    const unmet = decideTrial(rows, 0, 86_400_000, undefined, undefined, { fixes_class: "c", must_not_move: ["acceptance"] });
    const held = decideTrial(rows, 0, 86_400_000, undefined, undefined, { fixes_class: null, must_not_move: [] });
    expect(unmet.action).toBe("retire");
    expect(unmet.reason).toContain("prediction unmet");
    expect(held.reason).toContain("prediction held");
  });
});

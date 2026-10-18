import { describe, expect, it } from "vitest";
import { TRIAL_DEFAULTS, armMetrics, decideTrial } from "../../src/rooms/harness/server/trial";
import type { ArmAttempt } from "../../src/rooms/harness/server/store";

const DAY = 86_400_000;
const START = 1_000 * DAY;
let seq = 0;
const row = (arm: "new" | "old", state: string, extra: Partial<ArmAttempt> = {}): ArmAttempt =>
  ({ attemptId: `a${++seq}`, taskId: `t${seq}`, state, attemptNo: 1, arm, blockingFindings: 0, createdAt: START, ...extra });
const many = (arm: "new" | "old", n: number, state: string, extra: Partial<ArmAttempt> = {}) => Array.from({ length: n }, () => row(arm, state, extra));

describe("armMetrics", () => {
  it("ignores canceled and unfinished attempts", () => {
    const m = armMetrics([row("new", "accepted"), row("new", "canceled"), row("new", "running"), row("new", "blocked")]);
    expect(m.attempts).toBe(2);
    expect(m.accepted).toBe(1);
    expect(m.acceptanceRate).toBe(0.5);
  });

  it("counts retries (attempt_no > 1) and divides by distinct tasks", () => {
    const m = armMetrics([
      row("new", "validation_failed", { taskId: "x", attemptNo: 1 }),
      row("new", "validation_failed", { taskId: "x", attemptNo: 2 }),
      row("new", "accepted", { taskId: "x", attemptNo: 3 }),
      row("new", "accepted", { taskId: "y", attemptNo: 1 }),
    ]);
    expect(m.attempts).toBe(4);
    expect(m.tasks).toBe(2);
    expect(m.retries).toBe(2);
    expect(m.retriesPerTask).toBe(1);
  });

  it("sums blocking findings per attempt and is all zero for no rows", () => {
    const m = armMetrics([row("new", "accepted", { blockingFindings: 2 }), row("new", "blocked", { blockingFindings: 1 })]);
    expect(m.blockingFindings).toBe(3);
    expect(m.blockingPerAttempt).toBe(1.5);
    expect(armMetrics([])).toEqual({ attempts: 0, tasks: 0, accepted: 0, acceptanceRate: 0, retries: 0, retriesPerTask: 0, blockingFindings: 0, blockingPerAttempt: 0 });
  });
});

describe("decideTrial", () => {
  const { minPerArm, minPerArmLate, maxDays, acceptanceSlack } = TRIAL_DEFAULTS;
  const fresh = START + DAY;

  it("waits while an arm is under minPerArm", () => {
    const rows = [...many("new", minPerArm, "accepted"), ...many("old", minPerArm - 1, "accepted")];
    const d = decideTrial(rows, START, fresh);
    expect(d.action).toBe("wait");
    expect(d.reason).toContain(`${minPerArm}/${minPerArm} new`);
    expect(d.reason).toContain(`${minPerArm - 1}/${minPerArm} old`);
  });

  it("retires as unused when older than maxDays with fewer than minPerArmLate attempts in an arm", () => {
    const rows = [...many("new", minPerArmLate - 1, "accepted"), ...many("old", minPerArm, "accepted")];
    const d = decideTrial(rows, START, START + maxDays * DAY);
    expect(d.action).toBe("retire");
    expect(d.reason).toMatch(/^unused/);
  });

  it("decides late on minPerArmLate attempts per arm", () => {
    const rows = [...many("new", minPerArmLate, "accepted"), ...many("old", minPerArmLate, "blocked")];
    const d = decideTrial(rows, START, START + maxDays * DAY);
    expect(d.action).toBe("adopt");
  });

  it("adopts when the new arm accepts more and has no more blocking findings or retries", () => {
    const rows = [
      ...many("new", minPerArm, "accepted"),
      ...many("old", minPerArm - 2, "accepted"), ...many("old", 2, "blocked"),
    ];
    const d = decideTrial(rows, START, fresh);
    expect(d.action).toBe("adopt");
    expect(d.arms.new.acceptanceRate).toBe(1);
  });

  it("does not adopt a more accepted arm that has more blocking findings", () => {
    const rows = [
      ...many("new", minPerArm, "accepted", { blockingFindings: 1 }),
      ...many("old", minPerArm - 2, "accepted"), ...many("old", 2, "blocked"),
    ];
    const d = decideTrial(rows, START, fresh);
    expect(d.action).toBe("retire");
    expect(d.reason).toMatch(/^worse/);
  });

  it("retires with no measurable gain when the arms are equal", () => {
    const rows = [...many("new", minPerArm, "accepted"), ...many("old", minPerArm, "accepted")];
    const d = decideTrial(rows, START, fresh);
    expect(d.action).toBe("retire");
    expect(d.reason).toMatch(/^no measurable gain/);
  });

  it("retires as worse when acceptance drops more than the slack", () => {
    const drop = Math.ceil((acceptanceSlack + 0.2) * minPerArm);
    const rows = [
      ...many("new", minPerArm - drop, "accepted"), ...many("new", drop, "blocked"),
      ...many("old", minPerArm, "accepted"),
    ];
    const d = decideTrial(rows, START, fresh);
    expect(d.action).toBe("retire");
    expect(d.reason).toMatch(/^worse/);
  });

  it("tolerates an acceptance drop within the slack when something else improved", () => {
    const config = { ...TRIAL_DEFAULTS, minPerArm: 10, acceptanceSlack: 0.15 };
    const rows = [
      ...many("new", 9, "accepted"), ...many("new", 1, "blocked"),
      ...many("old", 10, "accepted", { blockingFindings: 1 }),
    ];
    const d = decideTrial(rows, START, fresh, config);
    expect(d.action).toBe("adopt");
  });

  it("does not count canceled attempts toward minPerArm", () => {
    const rows = [...many("new", minPerArm, "canceled"), ...many("old", minPerArm, "accepted")];
    expect(decideTrial(rows, START, fresh).action).toBe("wait");
  });
});

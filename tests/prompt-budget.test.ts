import { expect, it } from "vitest";
import { BB_AGENT_SESSIONS, LANE_PILOT_PM_SESSION } from "../src/rooms/native-agent/native-agent-overlay";

/**
 * Standing instructions are paid for in every turn of every thread, and a long prompt confuses a model more than it helps (Synapse AI
 * talk, 2026-10-08). Each ceiling sits about 10 % above the size on 2026-10-08, so a short addition passes and a silent doubling does
 * not. Over a ceiling: cut something first, or raise the number here on purpose, saying why in the commit.
 */
// pm +750 on 2026-11-17 (591 accounting): release 590 was 15,641; the current prompt carries required shared-repo and checkout-boundary rules.
// pm +500 on 2026-11-14 (SMA parity 4е): the PM is told that a task's plan is text kept in the task folder, that depends_on is the only order (code
// computes the waves) and that the planner revises a returned plan up to 3 rounds; the three additions were cut to 496 characters first.
const CEILING_CHARS = { pm: 16_500, "workflow-architect": 12_000, other: 2_000 };

it("keeps the PM session prompt under its size ceiling", () => {
  expect(LANE_PILOT_PM_SESSION.length).toBeLessThanOrEqual(CEILING_CHARS.pm);
});

it("keeps every other agent session prompt under its size ceiling", () => {
  for (const [id, prompt] of Object.entries(BB_AGENT_SESSIONS)) {
    const ceiling = id === "workflow-architect" ? CEILING_CHARS["workflow-architect"] : CEILING_CHARS.other;
    expect(prompt.length, `${id} is ${prompt.length} characters, ceiling ${ceiling}`).toBeLessThanOrEqual(ceiling);
  }
});

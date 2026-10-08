import { expect, it } from "vitest";
import { BB_AGENT_SESSIONS, LANE_PILOT_PM_SESSION } from "../src/rooms/native-agent/native-agent-overlay";

/**
 * Standing instructions are paid for in every turn of every thread, and a long prompt confuses a model more than it helps (Synapse AI
 * talk, 2026-10-08). Each ceiling sits about 10 % above the size on 2026-10-08, so a short addition passes and a silent doubling does
 * not. Over a ceiling: cut something first, or raise the number here on purpose, saying why in the commit.
 */
const CEILING_CHARS = { pm: 20_000, "workflow-architect": 12_000, other: 2_000 };

it("keeps the PM session prompt under its size ceiling", () => {
  expect(LANE_PILOT_PM_SESSION.length).toBeLessThanOrEqual(CEILING_CHARS.pm);
});

it("keeps every other agent session prompt under its size ceiling", () => {
  for (const [id, prompt] of Object.entries(BB_AGENT_SESSIONS)) {
    const ceiling = id === "workflow-architect" ? CEILING_CHARS["workflow-architect"] : CEILING_CHARS.other;
    expect(prompt.length, `${id} is ${prompt.length} characters, ceiling ${ceiling}`).toBeLessThanOrEqual(ceiling);
  }
});

import { describe, expect, it } from "vitest";
import { withoutSelectionMarkers } from "../src/rooms/native-agent/native-session";
import { MACHINE_STAGE_FAILURE } from "../src/rooms/phase/server/auto-stages";

// magicseo replay (2026-10-31): the PM was started from the CLI with the selection marker in its first message; the marker went into the
// phase's goal, the analysis helper (Gemini) got it in its prompt and the dispatch refused it as a profile.
describe("a selection marker never reaches a phase's goal", () => {
  const marker = "[lane-pilot-selection:656ba95b-1259-4d0b-b242-789118f7610f]";

  it("is cut from the owner's text, wherever it stands", () => {
    expect(withoutSelectionMarkers(`${marker}\n\nhttps://lk.magicseo.ru/ - надо просканировать сервис`)).toBe("https://lk.magicseo.ru/ - надо просканировать сервис");
    expect(withoutSelectionMarkers(`a ${marker} b`)).toBe("a b");
    expect(withoutSelectionMarkers("no marker here")).toBe("no marker here");
  });

  it("a helper refused for it failed from Lane Pilot's own fault, not the work's", () => {
    expect(MACHINE_STAGE_FAILURE.test("HTTP 409: Lane Pilot: Lane Pilot native profile needs Claude Code. Switch the composer provider back")).toBe(true);
  });
});

describe("a phase stopped by a loop of Lane Pilot's own failures goes on after the release that reads them so", () => {
  const words = "analyze ran out of tries (lp.analyze failed 2 time(s) in this version, 2 in the life of the phase; the last: HTTP 409: Lane Pilot: Lane Pilot native profile needs Claude Code. Switch the composer provider back, or start without the Lane mention.). Scope cut: no piece to withdraw; unmet: goal_met: no goal audit yet; no piece is proved, so the phase stops (empty scope).";
  const stopped = (closing: { by: string; words: string; at: number }, version = "0.1.409") => ({
    id: "ph_1", state: "stopped", stage: "discussion",
    record: { closing, autoFailures: { analyze: 2 }, autoFailuresTotal: { analyze: 2 }, autoFailuresVersion: version, partial: { at: 1, kept: [], unproven: [], unmet: [] }, scope: { revisions: 0, withdrawn: [] } },
  }) as never;

  it("the magicseo replay phase resumes under the next version, with its counters cleared", async () => {
    const { recoverStopped } = await import("../src/rooms/phase/server/auto-stages");
    const back = recoverStopped(stopped({ by: "Lane Pilot (loop exhausted)", words, at: 1_000 }), "0.1.410", 2_000);
    expect(back?.record).toMatchObject({ autoFailures: undefined, autoFailuresTotal: undefined });
    expect(back?.record).not.toHaveProperty("closing");
    expect(back?.note).toMatch(/Lane Pilot's own/);
  });

  it("stays stopped under the version that stopped it, a day later, when a person stopped it, or for a failure of the work", async () => {
    const { recoverStopped } = await import("../src/rooms/phase/server/auto-stages");
    expect(recoverStopped(stopped({ by: "Lane Pilot (loop exhausted)", words, at: 1_000 }), "0.1.409", 2_000)).toBeNull();
    expect(recoverStopped(stopped({ by: "Lane Pilot (loop exhausted)", words, at: 1_000 }), "0.1.410", 1_000 + 86_400_000)).toBeNull();
    expect(recoverStopped(stopped({ by: "owner", words, at: 1_000 }), "0.1.410", 2_000)).toBeNull();
    expect(recoverStopped(stopped({ by: "Lane Pilot (loop exhausted)", words: words.replace(/HTTP 409[^)]*/, "the plan is not admitted: no independent plan check"), at: 1_000 }), "0.1.410", 2_000)).toBeNull();
  });
});

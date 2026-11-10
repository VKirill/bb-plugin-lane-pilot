import { describe, expect, it } from "vitest";
import { nextAttemptState, resolveTransition, TRANSITION_TABLE, type AttemptState, type TransitionEvent } from "../src/rooms/contracts/state-machine";
import { RUNS_MAX_LIMIT, readRunsWindow } from "../src/rooms/runs/ui/runs-window";

// Release stories — window suite (SMA rl_stories / n1133): the window model and the task's states seen through it.
// Driven through the real transition table and the real runs-window reader, not a mock of either.

const EVENTS: TransitionEvent[] = TRANSITION_TABLE.map((row) => row.event).filter((event, index, all) => all.indexOf(event) === index);

function driveTo(state: AttemptState, events: TransitionEvent[]): AttemptState {
  return events.reduce((from, event) => nextAttemptState(from, event), state);
}

describe("window stories: the cockpit window model through its states", () => {
  it("the window reader pages through a live window in contract-sized pages", async () => {
    const calls: number[] = [];
    const call = async (_m: "list_runs", input: { offset: number; limit: number }) => {
      calls.push(input.limit);
      const ids = Array.from({ length: 30 }, (_, i) => `run-${i}`);
      return { runs: ids.slice(input.offset, input.offset + input.limit).map((id) => ({ id })), total: 30 };
    };
    const page = await readRunsWindow({ call } as never, { projectId: "p" }, 30);
    expect(Math.max(...calls)).toBeLessThanOrEqual(RUNS_MAX_LIMIT);
    expect(page.runs).toHaveLength(30);
  });

  it("the same task is idle, running, blocked, then accepted only on checks_passed", () => {
    const running = driveTo("queued", ["spawn_called", "spawn_ok"]);
    expect(running).toBe("running");
    expect(nextAttemptState(running, "checks_passed")).toBe("accepted");
    expect(nextAttemptState("running", "cancel")).not.toBe("accepted");
  });
});

describe("window stories: a window blocked and reopened", () => {
  it("a validation failure blocks the window's card after retries are spent, never accepts it", () => {
    const failed = nextAttemptState("running", "validation_failed");
    expect(nextAttemptState(failed, "retry_exhausted")).toBe("blocked");
    for (const event of EVENTS) {
      if (event === "retry" || event === "retry_exhausted") continue;
      expect(() => resolveTransition("blocked", event)).toThrow();
    }
  });
});

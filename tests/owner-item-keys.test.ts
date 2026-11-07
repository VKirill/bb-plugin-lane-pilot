import { expect, it } from "vitest";
import { writerQuestionKey } from "../src/rooms/writer/server";
import { runGoalItemKey } from "../src/rooms/run-goal/server";
import { phaseWordItemKey, phaseWordItemPrefix } from "../src/rooms/phase/server";
import { scheduleFailureItemKey } from "../src/rooms/schedule/server";

// Pin the owner-item key formats: existing rows in lane_pilot_owner_item carry these strings.
it("keeps the owner-item keys byte-identical", () => {
  expect(writerQuestionKey("run1", "task:9")).toBe("writer-question:run1:task:9");
  expect(runGoalItemKey("run1")).toBe("run-goal:run1");
  expect(phaseWordItemKey("ph1", "design")).toBe("phase-word:ph1:design");
  expect(phaseWordItemKey("ph1", "design", 2)).toBe("phase-word:ph1:design:2");
  expect(phaseWordItemKey("ph1", "lesson")).toBe("phase-word:ph1:lesson");
  expect(phaseWordItemPrefix("ph1")).toBe("phase-word:ph1:");
  expect(scheduleFailureItemKey("run1")).toBe("schedule-failure:run1");
});

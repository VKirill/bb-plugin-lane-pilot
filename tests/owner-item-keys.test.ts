import { expect, it } from "vitest";
import { writerQuestionKey } from "../src/rooms/writer/server/index";
import { scheduleFailureItemKey } from "../src/rooms/schedule/server";

// Pin the owner-item key formats: existing rows in lane_pilot_owner_item carry these strings.
it("keeps the owner-item keys byte-identical", () => {
  expect(writerQuestionKey("run1", "task:9")).toBe("writer-question:run1:task:9");
  expect(scheduleFailureItemKey("run1")).toBe("schedule-failure:run1");
});

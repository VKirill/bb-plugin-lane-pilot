import { expect, it } from "vitest";
import { dependsOnTask } from "../src/rooms/writer/server/start";

it("treats a dependent as no overlap blocker, by exact or base id", () => {
  expect(dependsOnTask(["gc-native-how"], "gc-native-how.5")).toBe(true);
  expect(dependsOnTask(["gc-native-how.5"], "gc-native-how.5")).toBe(true);
  expect(dependsOnTask(["gc-native"], "gc-native-how.5")).toBe(false);
  expect(dependsOnTask(["other"], "gc-native-how.5")).toBe(false);
  expect(dependsOnTask(undefined, "x")).toBe(false);
});

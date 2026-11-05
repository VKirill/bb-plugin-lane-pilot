import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import type { TaskV2 } from "../src/rooms/contracts";
import { createAttempt, createRun, createTask, openDatabase } from "../src/rooms/storage/database";
import { checkoutOwnsOverlap } from "../src/rooms/tasks";
import { batchAdviceFor } from "../src/rooms/writer/server/dispatch-guards";

const P = "/p/BB-сервис";
const task = (id: string, cwd: string, owns: string[]): TaskV2 => ({
  schema_version: 2, id, title: id, risk: "low", lane: "writer", project_cwd: cwd, read_first: [], interfaces: [], invariants: [],
  out_of_scope: [], expected_outputs: [owns[0]!], owns_paths: owns, never_touch: [], depends_on: [], objective: "o", acceptance: ["a"], verify: "none", verification: [],
});

it("compares owns_paths per checkout: one repo as written, nested from the outer, sibling repos never", () => {
  expect(checkoutOwnsOverlap(`${P}/plugins/bb-plugin-lane-pilot`, ["**"], `${P}/plugins/my-posts`, ["src/server/sessions.ts"])).toBe(false);
  expect(checkoutOwnsOverlap(`${P}/plugins/my-posts`, ["**"], `${P}/plugins/my-posts`, ["src/server/sessions.ts"])).toBe(true);
  expect(checkoutOwnsOverlap(P, ["plugins/my-posts/**"], `${P}/plugins/my-posts`, ["src/a.ts"])).toBe(true);
  expect(checkoutOwnsOverlap(P, ["plugins/other/**"], `${P}/plugins/my-posts`, ["src/a.ts"])).toBe(false);
});

// 2026-11-05: Lane Pilot's integrate-origin-main-b (owns `**`) was named to MyPosts' PM as the task its queue waited for.
it("dispatch advice names only open tasks of the new task's own checkout", () => {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "lp", "proj", "bb", `${P}/plugins/bb-plugin-lane-pilot`);
  createRun(db, "mp", "proj", "bb", `${P}/plugins/my-posts`);
  createTask(db, { id: "integrate-origin-main-b", runId: "lp", kind: "bb", contract: task("integrate-origin-main-b", `${P}/plugins/bb-plugin-lane-pilot`, ["**"]) });
  createAttempt(db, { id: "a1", runId: "lp", taskId: "integrate-origin-main-b" });
  const mine = task("mp-agent-context", `${P}/plugins/my-posts`, ["src/server/sessions.ts"]);
  expect(batchAdviceFor(db, "proj", "mp", mine).filter((line) => line.startsWith("queue:"))).toEqual([]);
  createTask(db, { id: "mp-ui", runId: "mp", kind: "bb", contract: task("mp-ui", `${P}/plugins/my-posts`, ["src/**"]) });
  createAttempt(db, { id: "a2", runId: "mp", taskId: "mp-ui" });
  expect(batchAdviceFor(db, "proj", "mp", mine).join("\n")).toMatch(/queue: mp-agent-context waits for 1 open task .*mp-ui/);
});

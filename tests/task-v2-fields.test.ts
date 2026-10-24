import { describe, expect, it } from "vitest";
import { TASK_V2_OPTIONAL, taskV2Schema } from "../src/rooms/contracts";
import { TASK_V2_REQUIRED, validateTaskV2 } from "../src/rooms/tasks/task-v2";

// The schema grew `priority` and `drawing` while the list the validator checks extra keys against did not: every piece a phase
// issued was refused as «priority: additionalProperties is false» (live ph_ae0a8de9db, 2026-10-24).
describe("task-v2 fields", () => {
  it("the validator knows every field the schema has", () => {
    const keys = Object.keys((taskV2Schema as unknown as { shape: Record<string, unknown> }).shape);
    const known = new Set<string>([...TASK_V2_REQUIRED, ...TASK_V2_OPTIONAL]);
    expect(keys.filter((key) => !known.has(key))).toEqual([]);
    expect([...known].filter((key) => !keys.includes(key))).toEqual([]);
  });
  it("a phase piece with priority and drawing passes", () => {
    const task = { schema_version: 2, id: "notes", title: "Notes", risk: "low", lane: "default", project_cwd: "/tmp/x", read_first: [], interfaces: [], invariants: [], out_of_scope: [],
      owns_paths: ["src/notes/**"], never_touch: [], expected_outputs: ["src/notes/store.js"], depends_on: [], verification: ["npm test"], acceptance: ["green"], priority: "high", drawing: ["mock.png"] };
    const result = validateTaskV2(task);
    expect(result.ok ? [] : result.errors.filter((error) => /additionalProperties/.test(error))).toEqual([]);
  });
});

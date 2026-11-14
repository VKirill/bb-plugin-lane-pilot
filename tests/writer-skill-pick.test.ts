import { describe, expect, it } from "vitest";
import type { TaskV2 } from "../src/rooms/contracts";
import { roleProfilePolicy } from "../src/rooms/contracts/helper-context";
import { createWriterSkillPick, recordedWriterSkills, taskTouchesWeb } from "../src/rooms/writer/server/skill-pick";

const LISTED = [
  { name: "lp-writer", description: "Lane-writer code style" },
  { name: "tavily", description: "Web search through the Tavily API" },
  { name: "three-js", description: "three.js scenes, cameras and materials" },
  { name: "ru-text", description: "Russian text quality" },
];

const task = {
  schema_version: 2, id: "T1", title: "Build the scene", risk: "low", lane: "web", project_cwd: "/home/ubuntu/apps/ru-text",
  read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: ["src/scene.ts"], owns_paths: ["src/scene.ts"],
  never_touch: [], depends_on: [], objective: "Draw the scene", acceptance: ["the scene renders"], verify: "tests", verification: [],
} as unknown as TaskV2;

function world(options: { listed?: unknown } = {}) {
  let listCalls = 0;
  const logged: string[] = [];
  const bb = {
    sdk: { skills: { list: async () => { listCalls += 1; if (options.listed === "fail") throw new Error("skills offline"); return { skills: options.listed ?? LISTED }; } } },
    log: { info: (message: string) => logged.push(message) },
  };
  const pick = createWriterSkillPick({ bb } as never, { log: (message) => logged.push(message) });
  const run = (hints?: string[]) => pick.pick({
    attemptId: "a1", projectId: "p1", hostId: "h", projectCwd: "/home/ubuntu/apps/ru-text",
    task: hints ? { ...task, skills: hints } : task,
  });
  return { run, logged, listCalls: () => listCalls };
}

describe("writer skill pick, by rule", () => {
  it("gives the writer the project folder's skills and the task's declared skills, no model asked", async () => {
    const pick = await world().run(["tavily", "not-listed"]);
    expect(pick.projectFolder).toEqual(["ru-text"]);
    expect(pick.hints).toEqual(["tavily"]);
    expect(pick.skills).toEqual(["ru-text", "tavily"]);
    const policy = roleProfilePolicy("writer", {}, { skills: pick.skills });
    expect(policy.skills).toEqual({ mode: "allow", names: ["lp-writer", "karpathy-guidelines", "ru-text", "tavily"] });
    expect(pick.reason).toBeNull();
  });

  it("adds modern-web-guidance by rule for a task that touches web files, only when the hub lists it", async () => {
    const withGuidance = [...LISTED, { name: "modern-web-guidance", description: "Modern web guidance" }];
    const webTask = { ...task, owns_paths: ["apps/site/components/Card.vue"], expected_outputs: ["apps/site/components/Card.vue"] } as unknown as TaskV2;
    const run = (listed: unknown, which: TaskV2) => {
      const bb = { sdk: { skills: { list: async () => ({ skills: listed }) } }, log: { info: () => {} } };
      return createWriterSkillPick({ bb } as never, { log: () => {} }).pick({ attemptId: "a1", projectId: "p1", hostId: "h", projectCwd: "/home/ubuntu/apps/ru-text", task: which });
    };
    expect((await run(withGuidance, webTask)).skills).toEqual(["ru-text", "modern-web-guidance"]);
    expect((await run(withGuidance, task)).skills).toEqual(["ru-text"]);
    expect((await run(LISTED, webTask)).skills).toEqual(["ru-text"]);
    expect(taskTouchesWeb({ owns_paths: ["src/a.scss"], expected_outputs: [], read_first: [] })).toBe(true);
    expect(taskTouchesWeb({ owns_paths: ["src/a.ts", "server/api.py"], expected_outputs: [], read_first: ["README.md"] })).toBe(false);
  });

  it("a failing skill list gives the writer its role skills and the reason", async () => {
    const pick = await world({ listed: "fail" }).run(["tavily"]);
    expect(pick.skills).toEqual([]);
    expect(pick.reason).toBe("list_error:skills offline");
  });

  it("lists the skills once for ten minutes", async () => {
    const env = world();
    await env.run();
    await env.run();
    expect(env.listCalls()).toBe(1);
  });

  it("reads the skills a dispatch recorded, and nothing from a dispatch without them", () => {
    expect(recordedWriterSkills({ skillPick: { skills: ["ru-text", 3] } })).toEqual(["ru-text"]);
    expect(recordedWriterSkills(undefined)).toEqual([]);
    expect(recordedWriterSkills({})).toEqual([]);
  });
});

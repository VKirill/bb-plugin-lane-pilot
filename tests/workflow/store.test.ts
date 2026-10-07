import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { globalWorkflowDir, loadWorkflowStore, projectWorkflowDir } from "../../src/workflow/store";
import { workflow } from "./fixtures";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "lp-wf-")); dirs.push(dir); return dir; };
const put = (dir: string, name: string, content: unknown) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, name), typeof content === "string" ? content : JSON.stringify(content)); };

describe("workflow store", () => {
  it("loads the built-ins, the global and the project directory, the narrowest scope winning by id", async () => {
    const home = temp(), project = temp();
    put(globalWorkflowDir(home), "demo.json", { ...workflow(), name: "Global demo" });
    put(globalWorkflowDir(home), "only-global.json", { ...workflow(), id: "only-global" });
    put(projectWorkflowDir(project), "demo.json", `// project copy\n${JSON.stringify({ ...workflow(), name: "Project demo" })}`);
    const store = await loadWorkflowStore({ builtin: [{ name: "demo.json", value: workflow() }], globalDir: globalWorkflowDir(home), projectDir: projectWorkflowDir(project) });
    expect(store.problems).toEqual([]);
    expect(store.list().map((item) => item.workflow.id).sort()).toEqual(["demo", "only-global"]);
    expect(store.get("demo")).toMatchObject({ origin: "project", workflow: { name: { en: "Project demo" } } });
    expect(store.get("only-global")?.origin).toBe("global");
  });

  it("reports an invalid file and does not let it shadow a valid workflow of a wider scope", async () => {
    const home = temp();
    put(globalWorkflowDir(home), "demo.json", { ...workflow(), name: "Broken", edges: [] });
    put(globalWorkflowDir(home), "garbage.json", "{ not json");
    const store = await loadWorkflowStore({ builtin: [{ name: "demo.json", value: workflow() }], globalDir: globalWorkflowDir(home) });
    expect(store.get("demo")).toMatchObject({ origin: "builtin", workflow: { name: { en: "Demo" } } });
    expect(store.problems.map((item) => item.source.split("/").pop()).sort()).toEqual(["demo.json", "garbage.json"]);
  });

  it("treats a missing directory as empty and resolves subworkflows against the merged set", async () => {
    const caller = workflow({
      id: "caller",
      nodes: [{ id: "call", type: "subworkflow", workflow: "demo", inputs: { query: "input.query" }, output: [{ name: "result", type: "string" }] }],
      edges: [{ from: "start", to: "call" }, { from: "call", to: "end", with: { result: "call.result" } }],
    });
    const store = await loadWorkflowStore({ builtin: [{ name: "demo.json", value: workflow() }, { name: "caller.json", value: caller }], globalDir: join(temp(), "nope") });
    expect(store.problems).toEqual([]);
    expect(store.resolve("demo")?.id).toBe("demo");
    expect(store.resolve("demo", 9)).toBeNull();
    const orphan = await loadWorkflowStore({ builtin: [{ name: "caller.json", value: caller }] });
    expect(orphan.get("caller")).toBeNull();
    expect(orphan.problems[0]?.problems.map((item) => item.code)).toContain("subworkflow_missing");
  });
});

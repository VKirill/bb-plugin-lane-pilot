import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LP_TASK_PIPELINE, BUILTIN_SOURCES, builtinWorkflow, builtinWorkflows } from "../../src/workflow/builtin";
import { END, START } from "../../src/workflow/schema";
import { loadWorkflowStore } from "../../src/workflow/store";
import { validateWorkflow } from "../../src/workflow/validate";

describe("built-in workflows", () => {
  it("every file in workflows/ is registered, valid and free of warnings", async () => {
    const files = readdirSync(join(__dirname, "../../workflows")).filter((name) => name.endsWith(".json")).sort();
    expect(BUILTIN_SOURCES.map((source) => source.name).sort()).toEqual(files);
    const store = await loadWorkflowStore({ builtin: BUILTIN_SOURCES });
    expect(store.problems).toEqual([]);
    for (const item of store.list()) expect(item.warnings, item.workflow.id).toEqual([]);
    expect(builtinWorkflows().map((workflow) => workflow.id)).toEqual(store.list().map((item) => item.workflow.id));
  });

  it("the committed JSON is what the loader reads (no stale copy)", () => {
    const text = JSON.parse(readFileSync(join(__dirname, "../../workflows/lp-task-pipeline.json"), "utf8"));
    expect(text.id).toBe(LP_TASK_PIPELINE);
    expect(text.nodes.length).toBe(builtinWorkflow(LP_TASK_PIPELINE)!.nodes.length);
  });

  it("lp-task-pipeline keeps today's stage order and the guarded quality-mode branches", () => {
    const workflow = builtinWorkflow(LP_TASK_PIPELINE)!;
    expect(workflow).toMatchObject({ status: "published", scope: { level: "builtin" } });
    const next = (from: string, matching?: (edge: (typeof workflow.edges)[number]) => boolean) => workflow.edges.filter((edge) => edge.from === from && (!matching || matching(edge))).map((edge) => edge.to);
    const happy = ["pm-read", "quality-mode", "plan-critique", "specialist-review", "ownership-base", "task-folder", "writer"];
    let at: string = START;
    const walked: string[] = [];
    while (at !== END) {
      const options = workflow.edges.filter((edge) => edge.from === at);
      // The unconditional edge is the path every stage takes when nothing blocks.
      const edge = options.find((candidate) => !candidate.when) ?? options[0]!;
      if (at !== START) walked.push(at);
      at = edge.to;
    }
    expect(walked).toEqual(happy);
    expect(next("quality-mode")).toEqual(["plan-critique-quick", "plan-critique"]);
    const quick = workflow.edges.find((edge) => edge.from === "quality-mode" && edge.to === "plan-critique-quick");
    expect(quick?.when).toEqual({ field: "mode", op: "eq", value: "quick" });
    // Every blocking branch ends at the exit with a reply, and the writer owns the stages that stay inside it.
    for (const block of ["block-pm-read", "block-plan-critique", "block-specialist", "block-ownership"]) expect(next(block)).toEqual([END]);
    expect(workflow.nodes.find((node) => node.id === "writer")).toMatchObject({ type: "lp-task", stages: expect.arrayContaining(["writer-agent", "verification", "code-critique", "acceptance-receipt"]) });
  });

  it("is also valid when checked on its own with the engine's checks", () => {
    expect(validateWorkflow(builtinWorkflow(LP_TASK_PIPELINE)!).filter((problem) => problem.level === "error")).toEqual([]);
  });
});

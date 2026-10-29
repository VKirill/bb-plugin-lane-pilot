import { describe, expect, it } from "vitest";
import { resolveTaskQualityMode } from "@lane-pilot/workflow-engine";
import { engineOn, journalDb, ok, wf } from "./engine-helpers";

const search = ok(() => ({ items: ["a"], count: 1, kind: "fresh" }));
const write = ok(() => ({ text: "written" }));

describe("quality mode of a task", () => {
  it("F-008: contract full in a standard graph keeps full", () => {
    expect(resolveTaskQualityMode({ contract: "full", node: "{{$mode}}", asked: "quick", workflow: { default: "standard" } }))
      .toEqual({ ok: true, mode: "full", source: "contract" });
    expect(resolveTaskQualityMode({ contract: "full", asked: "quick" })).toEqual({ ok: true, mode: "full", source: "contract" });
  });

  it("F-008: contract full inside fixed quick is a conflict, never silent quick", () => {
    expect(resolveTaskQualityMode({ contract: "full", node: "{{$mode}}", asked: "quick", workflow: { fixed: "quick", default: "quick" } }))
      .toMatchObject({ ok: false, code: "quality_mode_conflict" });
    expect(resolveTaskQualityMode({ node: "full", workflow: { fixed: "quick" } })).toMatchObject({ ok: false, code: "quality_mode_conflict" });
  });

  it("F-008: an explicit full input on a fixed-quick workflow is a conflict, and an inherited mode stays quick", async () => {
    const workflow = wf({ quality_mode: { default: "quick", fixed: "quick" } });
    const dbEngine = engineOn(journalDb(), { search, write });
    expect(() => dbEngine.start({ workflow, inputs: { query: "q", quality_mode: "full" } })).toThrow(/quality_mode full conflicts/);
    const started = dbEngine.start({ workflow, inputs: { query: "q" }, mode: "full" });
    expect((await started.done).status).toBe("succeeded");
    expect((dbEngine.journal.db.prepare("SELECT mode FROM lane_pilot_wf_run WHERE id=?").get(started.runId) as { mode: string }).mode).toBe("quick");
  });

  it("resolves node, then workflow floor, then project", () => {
    expect(resolveTaskQualityMode({ node: "quick", asked: "full", workflow: { default: "standard" } })).toEqual({ ok: true, mode: "quick", source: "node" });
    expect(resolveTaskQualityMode({ asked: "quick", workflow: { min: "standard", default: "standard" } })).toEqual({ ok: true, mode: "standard", source: "workflow" });
    expect(resolveTaskQualityMode({ project: "full" })).toEqual({ ok: true, mode: "full", source: "project" });
    expect(resolveTaskQualityMode({ node: "{{$mode}}", asked: "quick", workflow: { fixed: "quick" } })).toEqual({ ok: true, mode: "quick", source: "workflow" });
  });
});

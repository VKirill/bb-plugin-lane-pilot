import { describe, expect, it } from "vitest";
import { validateWorkflow } from "@lane-pilot/workflow-engine";
import { createPluginWall } from "../../src/rooms/wall/server/wall";
import { mountNightGraphs } from "../../src/rooms/night-graphs/server";
import { builtinWorkflow } from "../../src/rooms/workflow/builtin";
import { nightWorld } from "./world";

const FINDING = JSON.stringify({ verdict: "contract_wrong", summary: "the contract asks for a file the task does not own", action: "update_contract", evidence: [{ kind: "file", ref: "game/runner.py", line: 1, quote: "the runner fails here" }] });
const PLUGIN_PROJECT = "proj-bb";

function setup(options: { answerFor?: (args: Record<string, any>) => string | Error | undefined } = {}) {
  const w = nightWorld({ answerFor: options.answerFor ?? ((args) => (args.pluginMetadata?.role === "wall-analysis" ? "# analysis\nnext step: one owner for the runner" : FINDING)) });
  w.services.wall = createPluginWall(w.ctx, w.services);
  mountNightGraphs(w.ctx, w.services);
  const wall = w.services.wall as ReturnType<typeof createPluginWall>;
  /** An exhausted loop: one wall of kind task, waiting for the hunters on the next pass. */
  const exhaust = async () => wall.loopExhausted({ kind: "topic", id: "runner-file", title: "The runner file keeps failing", projectId: PLUGIN_PROJECT, done: "the topic was stopped", facts: ["four fixes failed"], texts: [{ path: "game/runner.py", text: "the runner fails here\nsecond line" }], runId: null, taskIds: [] });
  const row = (key: string) => w.db.prepare("SELECT state, hunt_state AS hunt, tokens_used, findings_json, analysis_json FROM lane_pilot_wall WHERE wall_key=?").get(key) as { state: string; hunt: string | null; tokens_used: number | null; findings_json: string | null; analysis_json: string | null } | undefined;
  return { w, wall, exhaust, row };
}

describe("the wall hunt graph", () => {
  it("is a built-in starter graph that passes the validator: hunters side by side, judge, analysis, record", () => {
    const hunt = builtinWorkflow("lp.wall-hunt")!;
    expect(hunt).toMatchObject({ id: "lp.wall-hunt", startedBy: "wall", status: "published" });
    expect(hunt.nodes.map((node) => node.id)).toEqual(["hunt", "judge", "analysis", "record", "done"]);
    expect(hunt.nodes.find((node) => node.id === "hunt")).toMatchObject({ type: "parallel", child: { uses: "lp.wall-hunter" } });
    expect(validateWorkflow(hunt).filter((problem) => problem.level === "error")).toEqual([]);
  });

  it("an exhausted loop is hunted by three hidden read-only readers of one graph run, then analysed; the findings and the analysis land in the wall row", async () => {
    const { w, wall, exhaust, row } = setup();
    const { key } = await exhaust();
    await wall.advance();
    await w.engine.idle();

    const runs = w.runs("lp.wall-hunt");
    expect(runs).toHaveLength(2);
    const night = new Date().toISOString().slice(0, 10);
    expect(runs.map((run) => run.idem_key).sort()).toEqual([`wall-hunt:${night}:${key}:analysis`, `wall-hunt:${night}:${key}:hunt`]);
    expect(runs.map((run) => w.engine.get(run.id)?.error)).toEqual([null, null]);
    expect(runs.every((run) => run.status === "succeeded")).toBe(true);

    const readers = w.state.spawned.filter((args) => args.pluginMetadata?.role === "wall-hunter");
    expect(readers).toHaveLength(3);
    for (const args of readers) {
      expect(args).toMatchObject({ visibility: "hidden", projectId: expect.any(String) });
      expect(args.pluginMetadata).toMatchObject({ lanePilotWorkflowNode: "hunt:child" });
      expect(args.pluginMetadata).not.toHaveProperty("parentPmThreadId");
    }
    expect(w.state.spawned.filter((args) => args.pluginMetadata?.role === "wall-analysis")).toHaveLength(1);
    // Hunted threads are records, not conversations: archived once read.
    expect(w.state.archived).toHaveLength(4);

    const wallRow = row(key)!;
    expect(wallRow.state).toBe("backlog");
    expect(wallRow.hunt).toBe("usable");
    expect(JSON.parse(wallRow.findings_json!).findings).toHaveLength(3);
    expect(JSON.parse(wallRow.analysis_json!).text).toContain("next step: one owner for the runner");
    expect(wallRow.tokens_used ?? 0).toBeGreaterThan(0);

    // Idempotent: another pass reads nothing again.
    const spawned = w.state.spawned.length;
    await wall.advance();
    await w.engine.idle();
    expect(w.state.spawned).toHaveLength(spawned);
    expect(w.runs("lp.wall-hunt")).toHaveLength(2);
  });

  it("a hunter that fails is a hunter with no finding: the others are judged, the run succeeds and the wall holds the findings", async () => {
    let hunters = 0;
    const { w, wall, exhaust, row } = setup({
      answerFor: (args) => {
        if (args.pluginMetadata?.role === "wall-analysis") return "# analysis";
        return ++hunters === 2 ? new Error("provider refused") : FINDING;
      },
    });
    const { key } = await exhaust();
    await wall.advance();
    await w.engine.idle();
    const hunt = w.runs("lp.wall-hunt").find((run) => run.idem_key.endsWith(":hunt"))!;
    expect(hunt.status).toBe("succeeded");
    expect(row(key)).toMatchObject({ hunt: "usable" });
    expect(JSON.parse(row(key)!.findings_json!).findings).toHaveLength(2);
  });

  it("when no hunter answers the run fails (the wall sees it) after the wall row says «unknown»; the loop still reaches its backlog item", async () => {
    const { w, wall, exhaust, row } = setup({ answerFor: (args) => (args.pluginMetadata?.role === "wall-analysis" ? "# analysis" : new Error("provider refused")) });
    const { key } = await exhaust();
    await wall.advance();
    await w.engine.idle();
    const hunt = w.runs("lp.wall-hunt").find((run) => run.idem_key.endsWith(":hunt"))!;
    expect(hunt.status).toBe("failed");
    expect(w.engine.get(hunt.id)).toMatchObject({ status: "failed", failedNode: "record" });
    expect(w.engine.get(hunt.id)!.error).toContain("wall_hunt_failed: no hunter gave an answer");
    expect(row(key)).toMatchObject({ hunt: "unknown", state: "backlog" });
    expect(JSON.parse(row(key)!.findings_json!).findings).toEqual([]);
  });
});

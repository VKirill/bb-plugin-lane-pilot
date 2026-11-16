import { describe, expect, it } from "vitest";
import { out, pathOf } from "./chain-helpers";
import { chainStore, runSim } from "./chain-harness";
import { engineOn, journalDb, ok, rows } from "./engine-helpers";

const runExactAgent = async (output: Record<string, unknown>) => {
  const workflow = (await chainStore()).get("pr-branch")!.workflow;
  const db = journalDb();
  const summary = await engineOn(db, { agent: ok(() => output) }).start({ workflow, inputs: { phase_id: "ph_a" } }).done;
  return { summary, db };
};

describe("pr-branch blocked handoff", () => {
  it("keeps the normal branch path and emits its branch details", async () => {
    const result = await runSim("pr-branch", {
      input: { phase_id: "ph_a" },
      stubs: { split: { branch: "review/ph_a", commits: 3, conflict: false, outcome: undefined } },
    });

    expect(pathOf(result)).toBe("split done");
    expect(out(result)).toMatchObject({ status: "done", branch: "review/ph_a", commits: 3 });
  });

  it("keeps the explicit conflict control on the blocked path", async () => {
    const result = await runSim("pr-branch", {
      input: { phase_id: "ph_a" },
      stubs: { split: { branch: "review/ph_a", commits: 1, conflict: true, outcome: undefined } },
    });

    expect(pathOf(result)).toBe("split blocked");
    expect(out(result)).toMatchObject({ status: "blocked", branch: "review/ph_a", commits: 1 });
  });

  it("routes an honest blocked agent response instead of failing before graph routing", async () => {
    const result = await runExactAgent({
      outcome: "blocked",
      blocker: { needs: "the base branch", from: "owner" },
      handoff: "The base branch is unavailable.",
    });

    expect(result.summary.status).toBe("succeeded");
    expect(result.summary.output).toEqual({ status: "blocked", blocker: { needs: "the base branch", from: "owner" }, handoff: "The base branch is unavailable." });
    expect(rows<{ node_id: string; state: string }>(result.db, "SELECT node_id, state FROM lane_pilot_wf_step WHERE run_id=? ORDER BY rowid", result.summary.runId)).toEqual([
      { node_id: "split", state: "succeeded" },
      { node_id: "blocked", state: "succeeded" },
    ]);
  });

  it("routes an honest failed agent response without inventing branch metadata", async () => {
    const result = await runExactAgent({ outcome: "failed", handoff: "The base branch is not a repository." });

    expect(result.summary.status).toBe("succeeded");
    expect(result.summary.output).toEqual({ status: "blocked", handoff: "The base branch is not a repository." });
    expect(rows<{ node_id: string }>(result.db, "SELECT node_id FROM lane_pilot_wf_step WHERE run_id=? ORDER BY rowid", result.summary.runId).map((row) => row.node_id)).toEqual(["split", "blocked"]);
  });

  it("does not claim completion for a partial outcome and preserves branch metadata", async () => {
    const result = await runSim("pr-branch", {
      input: { phase_id: "ph_a" },
      stubs: {
        split: {
          outcome: "partial",
          branch: "review/ph_a",
          commits: 2,
          conflict: false,
          handoff: "The branch is incomplete.",
        },
      },
    });

    expect(result.summary.status).toBe("succeeded");
    expect(pathOf(result)).toBe("split blocked");
    expect(out(result)).toMatchObject({ status: "blocked", branch: "review/ph_a", commits: 2, handoff: "The branch is incomplete." });
    expect(result.called("done")).toHaveLength(0);
  });
});

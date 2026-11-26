import { describe, expect, it, vi } from "vitest";
import { END, START, parseWorkflow } from "@lane-pilot/workflow-engine";
import { engineOn, journalDb, rows } from "./engine-helpers";

/** The same graph id at two versions: v2 adds an output the v1 snapshot does not know. */
function graph(version: 1 | 2) {
  return parseWorkflow({
    id: "snapshot-graph",
    version,
    name: { en: "snapshot", ru: "snapshot" },
    description: { en: "snapshot", ru: "snapshot" },
    outputs: [{ name: "woke", type: "string" }, ...(version === 2 ? [{ name: "added", type: "string" }] : [])],
    nodes: [{ id: "wait", type: "action", uses: "builtin:wait", params: { event: "snap.go", eventKey: "go", durationSec: 600 } }],
    edges: [{ from: START, to: "wait" }, { from: "wait", to: END, with: { woke: "wait.woke", ...(version === 2 ? { added: "wait.woke" } : {}) } }],
  });
}

const parked = (db: ReturnType<typeof journalDb>, runId: string) => rows(db, "SELECT 1 FROM lane_pilot_wf_step WHERE run_id=? AND state='waiting'", runId).length === 1;

describe("a run keeps the graph it started with", () => {
  it("finishes a parked run on its old snapshot, even on a new engine, while a new run uses the new graph", async () => {
    const db = journalDb();
    const first = engineOn(db, {}, { instanceId: "first", resolveWorkflow: () => graph(2) });
    const old = first.start({ workflow: graph(1), inputs: {} });
    await vi.waitFor(() => expect(parked(db, old.runId)).toBe(true));
    first.dispose();

    // A restart: the library now holds v2, a new engine knows only the journal.
    const second = engineOn(db, {}, { instanceId: "second", resolveWorkflow: () => graph(2) });
    await second.resume({ takeOver: true });
    const fresh = second.start({ workflow: graph(2), inputs: {}, key: "fresh" });
    await vi.waitFor(() => expect(parked(db, fresh.runId)).toBe(true));
    expect(await second.wake("snap.go", "go", {})).toBe(2);
    await second.idle();

    expect(second.get(old.runId)!.output).toEqual({ woke: "event" });
    expect(second.get(fresh.runId)!.output).toEqual({ woke: "event", added: "event" });
    expect(rows<{ workflow_version: number }>(db, "SELECT workflow_version FROM lane_pilot_wf_run WHERE id=?", old.runId)[0]!.workflow_version).toBe(1);
    second.dispose();
  });

  it("fails a resumed run whose snapshot is missing with a clear reason instead of guessing the current graph", async () => {
    const db = journalDb();
    const first = engineOn(db, {}, { instanceId: "first" });
    const run = first.start({ workflow: graph(1), inputs: {} });
    await vi.waitFor(() => expect(parked(db, run.runId)).toBe(true));
    first.dispose();
    db.prepare("UPDATE lane_pilot_wf_run SET definition_json='' WHERE id=?").run(run.runId);

    const second = engineOn(db, {}, { instanceId: "second", resolveWorkflow: () => graph(2) });
    await second.resume({ takeOver: true });
    await second.idle();
    const row = rows<{ status: string; reason: string | null }>(db, "SELECT status, reason FROM lane_pilot_wf_run WHERE id=?", run.runId)[0]!;
    expect(row.status).toBe("failed");
    expect(row.reason).toMatch(/snapshot/);
    second.dispose();
  });
});

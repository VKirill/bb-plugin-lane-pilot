import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { createAttempt, createRun, getAttempt, openDatabase, recordFinishedAttempt, setIllegalTransitionLog, transitionAttempt } from "../src/rooms/storage/database";
import { ATTEMPT_STATES, IllegalTransitionError, OPERATIONAL_MOVES, TRANSITION_TABLE, isLegalMove } from "../src/rooms/runs/state-machine";
import { failureClass } from "../src/rooms/runs/failure-class";

function setup() {
  const db = openDatabase(createFakePluginHost({ pluginId:"lane-pilot" }).bb);
  createRun(db, "run", "proj", "cli", "/w");
  db.prepare("INSERT INTO lane_pilot_task(id,run_id,kind,contract_json,created_at) VALUES('t','run','bb','{}',1)").run();
  let n = 0;
  /** An attempt put in `state` directly, the way a past run left it. */
  const attemptIn = (state:string) => {
    const id = `a${n += 1}`;
    createAttempt(db, { id, runId:"run", taskId:"t" });
    db.prepare("UPDATE lane_pilot_attempt SET state=? WHERE id=?").run(state, id);
    return id;
  };
  return { db, attemptIn };
}

describe("transitionAttempt enforces the state machine", () => {
  it("refuses a move that is in no table: typed error, state kept, journaled as refused, logged", () => {
    const { db, attemptIn } = setup();
    const log = vi.fn();
    setIllegalTransitionLog(log);
    try {
      const id = attemptIn("queued");
      expect(() => transitionAttempt(db, id, "running", { threadId:"thr", reason:"shortcut" })).toThrow(IllegalTransitionError);
      expect(getAttempt(db, id)).toMatchObject({ state:"queued", thread_id:null });
      expect(db.prepare("SELECT from_state, to_state, refused, reason FROM lane_pilot_attempt_transition WHERE attempt_id=?").all(id))
        .toEqual([{ from_state:"queued", to_state:"running", refused:1, reason:"illegal move: shortcut" }]);
      expect(log).toHaveBeenCalledWith(expect.stringContaining(`illegal attempt transition queued -> running (attempt ${id})`));
      // The error reads as a Lane Pilot fault where the writer loop turns it into «internal_error: …».
      try { transitionAttempt(db, id, "validation_failed"); } catch (error) {
        expect(error).toMatchObject({ name:"IllegalTransitionError", from:"queued", to:"validation_failed", attemptId:id });
        expect(failureClass("blocked", `internal_error: ${(error as Error).message}`)).toBe("harness");
      }
    } finally { setIllegalTransitionLog((message) => console.warn(message)); }
  });

  it("never lets a stop be undone: cancel_requested does not go back to running or to a failure", () => {
    const { db, attemptIn } = setup();
    setIllegalTransitionLog(() => undefined);
    try {
      for (const to of ["running", "provider_error", "validation_failed", "spawn_unknown"]) {
        expect(() => transitionAttempt(db, attemptIn("cancel_requested"), to)).toThrow(IllegalTransitionError);
      }
      expect(transitionAttempt(db, attemptIn("cancel_requested"), "canceled")).toBe(true);
    } finally { setIllegalTransitionLog((message) => console.warn(message)); }
  });

  it("accepts every row of the spec table", () => {
    const { db, attemptIn } = setup();
    for (const row of TRANSITION_TABLE.filter((item) => item.from !== null)) {
      const id = attemptIn(row.from!);
      const to = row.to === "stay" ? row.from! : row.to;
      expect(transitionAttempt(db, id, to), `${row.from} + ${row.event}`).toBe(true);
    }
  });

  it("accepts every documented operational move, each with a reason", () => {
    const { db, attemptIn } = setup();
    for (const row of OPERATIONAL_MOVES) {
      expect(row.why.length).toBeGreaterThan(20);
      expect(transitionAttempt(db, attemptIn(row.from), row.to), `${row.from} -> ${row.to}`).toBe(true);
    }
  });

  it("keeps the table narrow: of all state pairs only the listed ones are legal", () => {
    const legal = ATTEMPT_STATES.flatMap((from) => ATTEMPT_STATES.filter((to) => isLegalMove(from, to)).map((to) => `${from}>${to}`));
    // 24 spec rows (one is «stay») + the operational moves, without duplicates between them.
    const spec = new Set(TRANSITION_TABLE.filter((row) => row.from !== null).map((row) => `${row.from}>${row.to === "stay" ? row.from : row.to}`));
    const extra = new Set(OPERATIONAL_MOVES.map((row) => `${row.from}>${row.to}`));
    expect(legal.length).toBe(new Set([...spec, ...extra]).size);
    for (const pair of ["queued>running", "queued>spawn_unknown", "queued>validation_failed", "running>canceled", "blocked>queued", "accepted>running"]) {
      expect(legal).not.toContain(pair);
    }
  });

  it("an accepted or canceled attempt still refuses quietly, as before", () => {
    const { db, attemptIn } = setup();
    expect(transitionAttempt(db, attemptIn("accepted"), "running")).toBe(false);
    expect(transitionAttempt(db, attemptIn("canceled"), "accepted")).toBe(false);
  });

  it("records a finished native run through the steps it went through", () => {
    const { db, attemptIn } = setup();
    const id = attemptIn("queued");
    recordFinishedAttempt(db, id, "accepted");
    expect(db.prepare("SELECT from_state, to_state FROM lane_pilot_attempt_transition WHERE attempt_id=? ORDER BY rowid").all(id))
      .toEqual([{ from_state:"queued", to_state:"spawn_requested" }, { from_state:"spawn_requested", to_state:"running" }, { from_state:"running", to_state:"accepted" }]);
    const blocked = attemptIn("queued");
    recordFinishedAttempt(db, blocked, "blocked", "upstream refused");
    expect(getAttempt(db, blocked)).toMatchObject({ state:"blocked", reason:"upstream refused" });
    const running = attemptIn("queued");
    recordFinishedAttempt(db, running, "running");
    expect(getAttempt(db, running)?.state).toBe("running");
  });
});

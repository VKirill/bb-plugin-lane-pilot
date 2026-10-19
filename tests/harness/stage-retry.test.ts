import { describe, expect, it } from "vitest";
import { decideThreadCompletion } from "@lane-pilot/thread-observe";
import { runStage, sessionEndedEarly } from "../../src/rooms/harness/server/harness";
import { logIncidents } from "../../src/rooms/self-repair/server/self-repair";

// The nightly round of BB-сервис feature:shell, 2026-10-19 04:10 UTC: both editors on OpenCode (Gemini 3.8 Flash) ended
// within 48 s and the round reported «keep_base: both editors kept the current harness».
const INV = "harness_session_timeout:error:thread_status_error";
const DOM = "harness_session_timeout:error:thread_status_error:system_error:thread_command_failed:Command thread.start failed";
const TREE = { "memory.md": "- in this repo, the shell styles live in one file" };
const ok = (threadId: string) => ({ threadId, text: "<notes>one memory note</notes>", tree: TREE, error: null });
const ended = (threadId: string, error: string) => ({ threadId, text: "", tree: null, error });

describe("harness stage: a session that ended early gets one more", () => {
  it("names the refusal of the INV editor (real events of thr_we3abcuabe)", () => {
    const t = "thr_we3abcuabe", p = "ses_eada5b5fbffepwgRwATuot5Sk9";
    const events = [
      { threadId: t, seq: 1, createdAt: 1792383004514, type: "client/turn/requested", data: { requestId: "creq_4rpw2fy7sv", source: "spawn" } },
      { threadId: t, seq: 8, createdAt: 1792383007205, type: "system/thread-provisioning", data: { status: "completed" } },
      { threadId: t, seq: 9, createdAt: 1792383011784, type: "thread/identity", data: { providerThreadId: p } },
      { threadId: t, seq: 11, createdAt: 1792383011833, type: "turn/started", data: { providerThreadId: p } },
      { threadId: t, seq: 12, createdAt: 1792383011833, type: "turn/input/accepted", data: { providerThreadId: p, clientRequestId: "creq_4rpw2fy7sv" } },
      { threadId: t, seq: 30, createdAt: 1792383052605, type: "turn/completed", data: { providerThreadId: p, status: "failed", error: { message: "Agent stopped the turn: refusal" } } },
    ];
    expect(decideThreadCompletion({ threadId: t, status: "error", events, now: 1792383052700 })).toEqual({ ok: false, via: "error", detail:
        "thread_status_error:turn_failed:Agent stopped the turn: refusal" });
  });

  it("retries a refused turn and a failed start once, never a session that ran out of time", () => {
    expect(sessionEndedEarly(INV)).toBe(true);
    expect(sessionEndedEarly(DOM)).toBe(true);
    expect(sessionEndedEarly("spawn returned no thread id")).toBe(true);
    expect(sessionEndedEarly("harness_session_timeout:incomplete:status=active;queuedWork=none;started_seq=3;turn=none")).toBe(false);
    expect(sessionEndedEarly(null)).toBe(false);
  });

  it("the DOM editor's failed start is followed by a second session that edits", async () => {
    const queue = [ended("thr_yfpuimnbvx", DOM), ok("thr_second")];
    const missions: string[] = [], log: string[] = [];
    const result = await runStage({ mission: "M", fallback: {}, title: "Lane Pilot harness editor (DOM): feature:shell / *" },
      async (mission) => { missions.push(mission); return queue.shift()!; }, (line) => log.push(line), 0);
    expect(result).toMatchObject({ tree: TREE, keptBase: false, error: null, threadIds: ["thr_yfpuimnbvx", "thr_second"] });
    expect(missions[1]).toContain("A PREVIOUS SESSION IN THIS FOLDER STOPPED EARLY");
    // The handled restart is not an incident for the watcher; a second early end still is.
    expect(logIncidents(JSON.stringify({ ts: 2, message: log[0] }), 1)).toEqual([]);
    expect(logIncidents(JSON.stringify({ ts: 2, message: `harness proj_ejbam66722:feature:shell:*: dom editor failed: ${DOM}` }), 1)).toHaveLength(1);
  });

  it("two early ends keep the fallback with the last error; a timeout is not run again", async () => {
    let calls = 0;
    const twice = await runStage({ mission: "M", fallback: {}, title: "t" }, async () => { calls++; return ended(`thr_${calls}`, INV); }, () => undefined, 0);
    expect(twice).toMatchObject({ tree: {}, keptBase: true, error: INV, threadIds: ["thr_1", "thr_2"] });
    calls = 0;
    const timeout = "harness_session_timeout:incomplete:status=active;queuedWork=none;started_seq=3;turn=none";
    const timed = await runStage({ mission: "M", fallback: {}, title: "t" }, async () => { calls++; return ended("thr_t", timeout); }, () => undefined, 0);
    expect(calls).toBe(1);
    expect(timed.error).toBe(timeout);
  });

  it("a rejected tree still gets exactly one retry with the error verbatim", async () => {
    const bad = { threadId: "thr_bad", text: "<notes>x</notes>", tree: { "notes.txt": "off the surface" }, error: null };
    const missions: string[] = [];
    const result = await runStage({ mission: "M", fallback: {}, title: "t" }, async (mission) => { missions.push(mission); return bad; }, () => undefined, 0);
    expect(missions).toHaveLength(2);
    expect(missions[1]).toContain("YOUR PREVIOUS ATTEMPT WAS REJECTED");
    expect(result.keptBase).toBe(true);
    expect(result.error).toContain("notes.txt is off the editable surface");
  });
});

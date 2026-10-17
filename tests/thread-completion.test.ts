import { describe, expect, it } from "vitest";
import { decideThreadCompletion } from "../src/rooms/native-agent/thread-completion";

const threadId = "night-thread";

describe("decideThreadCompletion", () => {
  it("accepts the live night-review envelope while status is stopping", () => {
    expect(decideThreadCompletion({
      threadId:"thr_zy47uatpi5",
      status:"stopping",
      queuedWork:"none",
      events:[
        {
          id:"evt_ifdxx4nu43",
          scope:{ kind:"turn", turnId:"daa44df13e-t10" },
          threadId:"thr_zy47uatpi5",
          seq:16,
          createdAt:1790251285535,
          type:"turn/started",
          data:{ providerThreadId:"01a0d347-c4e0-7181-8b6f-aa1c631378d4" },
        },
        {
          id:"evt_t9dpdy498c",
          scope:{ kind:"turn", turnId:"daa44df13e-t10" },
          threadId:"thr_zy47uatpi5",
          seq:38,
          createdAt:1790251285535,
          type:"turn/completed",
          data:{
            providerThreadId:"01a0d347-c4e0-7181-8b6f-aa1c631378d4",
            status:"completed",
            providerCheckpointId:"01a0d347-c631-7240-a9ac-43b97486ccd3",
          },
        },
      ],
    })).toEqual({ ok:true, via:"turn_completed" });
  });

  it("accepts the live docs-maintainer rows seq16/26", () => {
    expect(decideThreadCompletion({
      threadId:"thr_ch3hmmq4bp",
      status:"starting",
      queuedWork:"unknown",
      events:[
        { seq:26, type:"turn/completed", threadId:"thr_ch3hmmq4bp", data:{ status:"completed" } },
        { seq:16, type:"turn/started", threadId:"thr_ch3hmmq4bp", data:{} },
      ],
    })).toEqual({ ok:true, via:"turn_completed" });
  });

  it("accepts started then completed while status stays starting", () => {
    expect(decideThreadCompletion({
      threadId,
      status:"starting",
      events:[
        { type:"turn/started", threadId, seq:1 },
        { type:"turn/completed", threadId, seq:2, data:{ status:"completed" } },
      ],
    })).toEqual({ ok:true, via:"turn_completed" });
  });

  it("rejects idle without a current terminal and stale completed after a later started", () => {
    expect(decideThreadCompletion({ threadId, status:"idle", queuedWork:"none", events:[] }))
      .toEqual({ ok:false, via:"incomplete", detail:"status=idle;queuedWork=none;started_seq=none;turn=none" });
    expect(decideThreadCompletion({
      threadId,
      status:"idle",
      queuedWork:"none",
      events:[
        { type:"turn/completed", threadId, seq:1, data:{ status:"completed" } },
        { type:"turn/started", threadId, seq:2 },
      ],
    })).toEqual({ ok:false, via:"incomplete", detail:"status=idle;queuedWork=none;started_seq=2;turn=none" });
  });

  it("rejects a newest-page of 50 events when a later started has no completion", () => {
    const history: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 25; i += 1) {
      history.push({ type:"turn/started", threadId, seq:i * 2 + 1 });
      history.push({ type:"turn/completed", threadId, seq:i * 2 + 2, data:{ status:"completed" } });
    }
    history.push({ type:"turn/started", threadId, seq:51 });
    const newestPage = [...history].sort((left, right) => Number(right.seq) - Number(left.seq)).slice(0, 50);
    expect(decideThreadCompletion({ threadId, status:"starting", queuedWork:"none", events:newestPage }))
      .toEqual({ ok:false, via:"incomplete", detail:"status=starting;queuedWork=none;started_seq=51;turn=none" });
  });

  it("rejects missing status, error, and interrupted terminals", () => {
    expect(decideThreadCompletion({
      threadId,
      status:"starting",
      events:[
        { type:"turn/started", threadId, seq:1 },
        { type:"turn/completed", threadId, seq:2, data:{} },
      ],
    }).ok).toBe(false);
    expect(decideThreadCompletion({ threadId, status:"error", events:[] }))
      .toEqual({ ok:false, via:"error", detail:"thread_status_error" });
    expect(decideThreadCompletion({
      threadId,
      status:"stopping",
      events:[
        { type:"turn/started", threadId, seq:1 },
        { type:"turn/completed", threadId, seq:2, data:{ status:"interrupted" } },
      ],
    })).toEqual({ ok:false, via:"canceled", detail:"turn_interrupted" });
  });

  it("names BB's cause of a thread in status error (live pm-reader thr_pchcvfzutr, 2026-10-16)", () => {
    // The host daemon of host_rwrxyi39aw was down 15:16-16:07 UTC; on its restart BB interrupted the helper. The bare
    // «thread_status_error» read as Lane Pilot's fault (triage orchestrator 0.97) and raised a self-repair.
    const t = "thr_pchcvfzutr", turn = { kind:"turn", turnId:"da9e003827-t4" }, providerThreadId = "06d78289-f0f8-42a5-9e33-b570e621ee3e";
    const events = [
      { id:"evt_tf2jq5hdc8", scope:{ kind:"thread" }, threadId:t, seq:1, createdAt:1792164326123, type:"client/turn/requested", data:{ direction:"outbound", requestId:"creq_9u7k25922u", source:"spawn" } },
      { id:"evt_pvc3x3h3im", scope:{ kind:"thread" }, threadId:t, seq:3, createdAt:1792164328131, type:"thread/identity", data:{ providerThreadId } },
      { id:"evt_f3qf4u3ekb", scope:turn, threadId:t, seq:6, createdAt:1792164328131, type:"turn/started", data:{ providerThreadId } },
      { id:"evt_a3bgavubms", scope:turn, threadId:t, seq:7, createdAt:1792164328131, type:"turn/input/accepted", data:{ providerThreadId, clientRequestId:"creq_9u7k25922u" } },
      { id:"evt_88qahfgpx2", scope:turn, threadId:t, seq:8, createdAt:1792166841153, type:"turn/completed", data:{ providerThreadId, status:"interrupted" } },
      { id:"evt_5etwtgpexg", scope:turn, threadId:t, seq:9, createdAt:1792166841153, type:"system/error", data:{ code:"thread_command_failed", message:"Thread interrupted because the host daemon disconnected", detail:"Please retry the thread to continue." } },
      { id:"evt_9bgmcqvnta", scope:{ kind:"thread" }, threadId:t, seq:10, createdAt:1792166841153, type:"system/thread/interrupted", data:{ reason:"host-daemon-restarted" } },
    ];
    expect(decideThreadCompletion({ threadId:t, status:"error", queuedWork:"none", events, now:1792166841516 })).toEqual({ ok:false, via:"error",
      detail:"thread_status_error:system_error:thread_command_failed:Thread interrupted because the host daemon disconnected" });
    // Only the interruption itself, no system/error: its reason is named.
    expect(decideThreadCompletion({ threadId:t, status:"error", events:events.filter((row) => row.type !== "system/error") }).detail)
      .toBe("thread_status_error:thread_interrupted:host-daemon-restarted");
  });

  it("does not end on a sub-agent's interrupted turn (live docs agent thr_vpv6743wkq, 2026-10-03)", () => {
    const t = "thr_vpv6743wkq";
    const ev = (seq:number, type:string, data:Record<string, unknown> = {}, createdAt = 1790994000000 + seq) => ({ threadId:t, seq, createdAt, type, data:{ providerThreadId:"p", ...data } });
    const events = [
      ev(278, "client/turn/requested", {}, 1790993645000),
      ev(279, "turn/started"),
      ev(280, "turn/input/accepted", { clientRequestId:"creq_hsqf8z2he4" }),
      ev(423, "turn/started", { parentToolCallId:"dab1efe01b-i2253" }),
      ev(744, "turn/completed", { status:"interrupted", parentToolCallId:"dab1efe01b-i2253" }),
    ];
    expect(decideThreadCompletion({ threadId:t, status:"active", events, requestedAfter:1790993640000 })).toMatchObject({ ok:false, via:"incomplete" });
    expect(decideThreadCompletion({ threadId:t, status:"idle", events:[...events, ev(774, "turn/completed", { status:"completed" })], requestedAfter:1790993640000 }))
      .toEqual({ ok:true, via:"turn_completed" });
  });
});

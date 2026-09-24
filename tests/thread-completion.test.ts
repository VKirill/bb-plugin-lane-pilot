import { describe, expect, it } from "vitest";
import { decideThreadCompletion } from "../src/thread-completion";

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
});

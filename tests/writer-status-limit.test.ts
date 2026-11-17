// The watcher's status-error path (watchWriterRun): a thread status error that names the provider's usage limit must end the
// attempt as writer_provider_limit and hold that provider/model pair on the breaker, so the next writer-chain walk skips it —
// not a generic «writer thread status error» that sends the retry back to the spent pair (opencode2 retried four times on a
// «Usage limit reached» event, 2026-11). The generic error, the thread.start failure and the concurrency-queue wait stay as they were.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import type { PrototypeConfig, TaskV2 } from "../src/rooms/contracts";
import { createAttempt, createRun, createTask, getAttempt, openDatabase, saveReasoningTrace, transitionAttempt } from "../src/rooms/plugin-db";
import { breakerKey, createProviderBreaker } from "@lane-pilot/resilience";
import { seenProviderLimit } from "../src/rooms/platform/server";
import { walkWriterChain, writerHold, type WriterHoldDeps } from "../src/rooms/writer/server/writer-hold";
import { watchWriterRun } from "../src/rooms/writer/server/watch-writer";
import { createWriterFinish } from "../src/rooms/writer/server/finish";

const config: PrototypeConfig = {
  projectId:"P", hostId:"h", pmWorkspacePath:"/repo", writerWorkspacePath:"/repo",
  pmProviderId:"codex", pmModel:"codex-test", writerProviderId:"opencode2", writerModel:"gemini-router",
};
const task: TaskV2 = {
  schema_version:2, id:"t1", title:"Write", risk:"low", lane:"writer", project_cwd:"/repo", read_first:[], interfaces:[], invariants:[],
  out_of_scope:[], expected_outputs:["note.txt"], owns_paths:["note.txt"], never_touch:[], depends_on:[],
  objective:"write", acceptance:["file exists"], verify:"none", verification:[],
};

const providerError = (message: string) => [{ type:"provider/error", threadId:"writer-1", seq:1, createdAt:Date.now(), data:{ message } }];

/** A running attempt watched through the real finish: real providerFailed transition and real holdProviderLimit on a real breaker. */
function world(options:{ events:unknown[]; status?:string; trace?:boolean }) {
  const { bb } = createFakePluginHost({ pluginId:"lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run", "P", "cli", "/repo");
  createTask(db, { id:"t1", runId:"run", kind:"bb", contract:task });
  createAttempt(db, { id:"a1", runId:"run", taskId:"t1" });
  transitionAttempt(db, "a1", "spawn_requested");
  transitionAttempt(db, "a1", "running", { threadId:"writer-1" });
  if (options.trace !== false) saveReasoningTrace(db, { attemptId:"a1", runId:"run", providerId:"opencode2", model:"gemini-router", threadId:"writer-1",
    planSha256:"p", sourceLength:1, requestedReasoningLevel:"default", effectiveReasoningLevel:"default",
    fallbackReason:null, serviceTier:null, requestedServiceTier:"default" } as never);
  const breaker = createProviderBreaker();
  const threads = {
    get:async () => ({ status:options.status ?? "error" }),
    events:{ list:async () => options.events },
    queue:{ list:async () => [] },
    list:async () => [],
    stop:async () => undefined,
    output:async () => ({ text:"done" }),
  };
  const bbCtx = { storage:bb.storage, log:{ warn() {}, error() {} }, sdk:{ threads, files:{ read:async () => ({ content:"" }) } } };
  const ctx = {
    state:{ disposed:false },
    bb:bbCtx,
    db, getThreadBounded:async () => ({ status:options.status ?? "error" }),
    host:{ call:async () => ({}) }, isDisposed:() => false, log:() => undefined,
  };
  const finish = createWriterFinish(ctx as never, { providerBreaker:breaker,
    validateWriterResult:async () => ({ status:"accepted" }),
    persistWriterAcceptance:async () => ({ state:"passed" }),
    workspaceDirt:async () => ({ ok:true, snapshots:[] }),
    runBudgetFor:() => ({ snapshot:() => ({ limits:{} }), check:() => ({ ok:true }), noteTokens:() => undefined }) } as never);
  const run = () => finish.finishWriterAttempt({ projectId:"P", config, task, runId:"run", taskId:"t1", attemptId:"a1", pmThreadId:"pm", writerThreadId:"writer-1", dirtBefore:[] });
  const chain = [{ providerId:"opencode2", model:"gemini-router" }, { providerId:"codex", model:"codex-test" }];
  const walk = (at?:number, opts?:{ breaker?:ReturnType<typeof createProviderBreaker>; usageHold?:(input:{ providerId:string; model:string }) => Promise<{ percent:number; window:string; resetsAt:string|null } | null> }) =>
    walkWriterChain(chain, { hostId:"h", settings:{} }, { breaker:opts?.breaker ?? breaker, presence:undefined, usage:{ hold:opts?.usageHold ?? (async () => null) }, coreHosts:() => true }, at);
  return { db, breaker, bbCtx, chain, walk, run };
}

describe("a writer thread status error", () => {
  it("ends the attempt as writer_provider_limit, notes the seen limit once and skips the pair on the next chain walk", async () => {
    const w = world({ events:providerError("AppId:**qD9O Usage limit reached.") });
    const result = await w.run();
    expect(result).toMatchObject({ status:"provider_error", attemptId:"a1", writerThreadId:"writer-1" });
    expect(result.reason).toMatch(/^writer_provider_limit: /);
    expect(result.reason).toContain("Usage limit reached");
    expect(getAttempt(w.db, "a1")).toMatchObject({ state:"provider_error", reason:result.reason });
    expect(w.breaker.snapshot(Date.now()).find((row) => row.key === breakerKey("opencode2", "gemini-router"))?.state).toBe("open");
    // The helper seam got the same one notice: its hold names it, and the breaker's open ends inside the seen-limit hour.
    expect(seenProviderLimit(w.bbCtx, "opencode2", "gemini-router")?.window).toContain("Usage limit reached");
    expect(w.breaker.snapshot(Date.now() + 59 * 60_000).find((row) => row.key === breakerKey("opencode2", "gemini-router"))?.state).toBe("open");
    const walk = await w.walk();
    expect(walk.free).toMatchObject({ member:{ providerId:"codex", model:"codex-test" }, index:1 });
    expect(walk.holds).toHaveLength(1);
    expect(walk.holds[0]!.hold.reason).toContain("breaker_open:opencode2/gemini-router");
  });

  // W2 (review parallel-593-writer-status-limit-review.json): parked wakes fire at 5.8-6.8 min; the seen-limit hold the
  // watcher recorded (an hour the first time) keeps the spent pair open past the waker's walk.
  it("still skips the exhausted pair when the chain is walked after the cool-down window", async () => {
    const w = world({ events:providerError("AppId:**qD9O Usage limit reached.") });
    await w.run();
    const walk = await w.walk(Date.now() + 7 * 60_000);
    expect(walk.free).toMatchObject({ member:{ providerId:"codex", model:"codex-test" }, index:1 });
  });

  // The hold is bounded, not a ban: past the seen-limit window the pair is half_open and a fresh walk may trial it again —
  // the same policy the breaker applies to a transient failure after its cool-down.
  it("offers the pair again after the seen-limit window ends", async () => {
    const w = world({ events:providerError("AppId:**qD9O Usage limit reached.") });
    await w.run();
    const walk = await w.walk(Date.now() + 61 * 60_000);
    expect(w.breaker.snapshot(Date.now() + 61 * 60_000).find((row) => row.key === breakerKey("opencode2", "gemini-router"))?.state).toBe("half_open");
    expect(walk.free).toMatchObject({ member:{ providerId:"opencode2", model:"gemini-router" }, index:0 });
  });

  // Declared limitation, not restart-proof: the breaker and the seen-limit map are this instance's memory, so a reload
  // inside the hold window offers the pair once more — identical to the silence-path and thread-start holds.
  it("documents the reload loss: a new instance's breaker does not carry the hold", async () => {
    const w = world({ events:providerError("AppId:**qD9O Usage limit reached.") });
    await w.run();
    const walk = await w.walk(Date.now() + 7 * 60_000, { breaker:createProviderBreaker() });
    expect(walk.free).toMatchObject({ member:{ providerId:"opencode2", model:"gemini-router" }, index:0 });
    expect(seenProviderLimit({}, "opencode2", "gemini-router")).toBeNull();
  });

  // W4: when EVERY member is held the parked attempt must wait for the hold's real end — the seen-limit hour, or the
  // reset a provider named — not a repark a millisecond later on every wake tick until the window passes.
  it("parks an all-held chain at the quota hold's actual end, not a 1 ms repark", async () => {
    const t0 = Date.now();
    const w = world({ events:providerError("AppId:**qD9O Usage limit reached.") });
    await w.run();
    const codexHeld = async (input:{ providerId:string; model:string }) =>
      input.providerId === "codex" ? { percent:100, window:"w", resetsAt:new Date(t0 + 120 * 60_000).toISOString() } : null;
    const walk = await w.walk(t0 + 7 * 60_000, { usageHold:codexHeld });
    expect(walk.free).toBeUndefined();
    expect(walk.wakeAt).toBeGreaterThan(t0 + 59 * 60_000);
    expect(walk.wakeAt).toBeLessThanOrEqual(t0 + 60 * 60_000 + 5_000);
  });

  it("reports the provider-named reset as the park's wake time", async () => {
    const t0 = Date.now();
    const breaker = createProviderBreaker();
    breaker.record(breakerKey("opencode2", "gemini-router"), "exhausted", t0, t0 + 90 * 60_000);
    const w = world({ events:[] });
    const codexHeld = async () => ({ percent:100, window:"w", resetsAt:new Date(t0 + 120 * 60_000).toISOString() });
    const walk = await w.walk(t0 + 7 * 60_000, { breaker, usageHold:codexHeld });
    expect(walk.free).toBeUndefined();
    expect(walk.wakeAt).toBe(t0 + 90 * 60_000);
  });

  // A pair past its hold is half_open, not refused: the walk does not take the trial token — the caller that actually
  // starts the writer gets it. The ordinary five-minute cool-down keeps its old arithmetic: no earlier wake, no later.
  it("leaves a half-open pair eligible without spending its trial", async () => {
    const t0 = Date.now();
    const breaker = createProviderBreaker();
    const key = breakerKey("opencode2", "gemini-router");
    breaker.record(key, "exhausted", t0);
    const w = world({ events:[] });
    const walk = await w.walk(t0 + 6 * 60_000, { breaker });
    expect(walk.free).toMatchObject({ member:{ providerId:"opencode2", model:"gemini-router" }, index:0 });
    const trial = breaker.decide(key, t0 + 6 * 60_000);
    expect(trial.allow).toBe(true);
  });

  it("keeps the ordinary cool-down wake at openedAt plus five minutes", async () => {
    const t0 = Date.now();
    const breaker = createProviderBreaker();
    breaker.record(breakerKey("opencode2", "gemini-router"), "exhausted", t0);
    const hold = await writerHold({ providerId:"opencode2", model:"gemini-router", hostId:"h", settings:{} },
      { breaker, presence:undefined, usage:{ hold:async () => null }, coreHosts:() => true }, t0 + 60_000);
    expect(hold?.until).toBe(t0 + 5 * 60_000);
  });

  // A terminal provider/error naming the limit is the provider's own verdict regardless of what the status read at poll
  // time: a still-"active" thread gets the same classification and hold (the turn is dead; the watcher stops the thread).
  it("classifies the same limit event while the thread still reads active", async () => {
    const w = world({ events:providerError("AppId:**qD9O Usage limit reached."), status:"active" });
    const result = await w.run();
    expect(result).toMatchObject({ status:"provider_error", attemptId:"a1" });
    expect(result.reason).toMatch(/^writer_provider_limit: /);
    expect(w.breaker.snapshot(Date.now()).find((row) => row.key === breakerKey("opencode2", "gemini-router"))?.state).toBe("open");
  });

  // A limit without a saved trace still fails the attempt as writer_provider_limit; no pair is invented to hold.
  it("fails an untraced attempt without inventing a provider to hold", async () => {
    const w = world({ events:providerError("AppId:**qD9O Usage limit reached."), trace:false });
    const result = await w.run();
    expect(result).toMatchObject({ status:"provider_error", attemptId:"a1" });
    expect(result.reason).toMatch(/^writer_provider_limit: /);
    expect(w.breaker.snapshot(Date.now()).some((row) => row.state === "open")).toBe(false);
    expect(seenProviderLimit(w.bbCtx, "opencode2", "gemini-router")).toBeNull();
  });

  it("stays a generic provider error when the event names no provider limit", async () => {
    const w = world({ events:providerError("socket exploded") });
    const result = await w.run();
    expect(result).toMatchObject({ status:"provider_error", attemptId:"a1" });
    expect(result.reason).toBe("writer thread status error: provider_error:socket exploded");
    expect(w.breaker.snapshot(Date.now()).some((row) => row.state === "open")).toBe(false);
  });

  it("keeps the thread.start failure on the not-started reason and its hold", async () => {
    const w = world({ events:providerError("Command thread.start failed: vk_required") });
    const result = await w.run();
    expect(result).toMatchObject({ status:"provider_error", attemptId:"a1" });
    expect(result.reason).toMatch(/^writer_provider_unavailable:thread_not_started: /);
  });
});

describe("a turn waiting in the concurrency queue", () => {
  it("is not failed by the provider start limit", async () => {
    const { bb } = createFakePluginHost({ pluginId:"lane-pilot" });
    const db = openDatabase(bb);
    let polls = 0;
    const ctx = {
      state:{ disposed:false },
      bb:{ storage:bb.storage, log:{ warn() {}, error() {} }, sdk:{ threads:{
        get:async () => ({ status:"active" }),
        events:{ list:async () => [{ type:"client/turn/requested", threadId:"writer-1", seq:1, createdAt:Date.now() - 200_000, data:{} }] },
        queue:{ list:async () => [{ waitingOn:{ kind:"plugin" } }] },
        list:async () => [], stop:async () => undefined,
      } } },
      db, getThreadBounded:async () => ({ status:++polls > 1 ? "idle" : "active" }),
      host:{ call:async () => ({}) }, isDisposed:() => false, log:() => undefined,
    };
    const providerFailed = vi.fn(() => null);
    const holdProviderLimit = vi.fn();
    const result = await watchWriterRun({
      ctx:ctx as never,
      services:{ runBudgetFor:() => ({ snapshot:() => ({ limits:{} }), check:() => ({ ok:true }), noteTokens:() => undefined }) } as never,
      input:{ projectId:"P", runId:"run", taskId:"t1", attemptId:"a1", writerThreadId:"writer-1", task } as never,
      facts:{}, providerFailed, holdProviderLimit,
    });
    expect(result).toBeNull();
    expect(providerFailed).not.toHaveBeenCalled();
    expect(holdProviderLimit).not.toHaveBeenCalled();
  });
});

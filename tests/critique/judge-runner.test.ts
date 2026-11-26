import { describe, expect, it, vi } from "vitest";
import { JUDGE_VERDICTS, parseJudgeVerdict } from "../../src/rooms/critique";
import { logJudgeVerdict, runHelperPrompt, runJudge } from "../../src/rooms/critique/server";

function stubBb(options?: {
  outputs?: Record<string, string>;
  threadStatuses?: Record<string, string[]>;
  failOutputOn?: Set<string>;
}) {
  let spawnCount = 0;
  const debugLines: string[] = [];
  const stopped: string[] = [];
  const getCalls = new Map<string, number>();
  const bb = {
    log: {
      debug: (msg: string) => debugLines.push(msg),
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    sdk: {
      providers: {
        list: async () => [
          { id: "codex", available: true, capabilities: { supportsServiceTier: true }, serviceTiers: [{ id: "default" }, { id: "fast" }] },
          { id: "claude-code", available: true, capabilities: { supportsServiceTier: false }, serviceTiers: [{ id: "default" }] },
        ],
        models: async ({ providerId }: { providerId: string }) => ({
          models: [{
            id: providerId === "codex" ? "gpt-6.1-sol" : "claude-opus-5-5",
            model: providerId === "codex" ? "gpt-6.1-sol" : "claude-opus-5-5",
            supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }],
          }],
        }),
      },
      threads: {
        events: {
          list: async ({ threadId }: { threadId: string }) => [
            { type: "turn/started", threadId, seq: 1 },
            { type: "turn/completed", threadId, seq: 2, data: { status: "completed" } },
          ],
        },
        get: async ({ threadId }: { threadId: string }) => {
          const idx = getCalls.get(threadId) ?? 0;
          getCalls.set(threadId, idx + 1);
          const seq = options?.threadStatuses?.[threadId];
          const status = seq ? (seq[idx] ?? seq[seq.length - 1] ?? "idle") : "idle";
          return { id: threadId, status, queuedWork: false };
        },
        stop: async ({ threadId }: { threadId: string }) => {
          stopped.push(threadId);
          return {};
        },
        output: async ({ threadId }: { threadId: string }) => {
          if (options?.failOutputOn?.has(threadId)) return { output: "" };
          return { output: options?.outputs?.[threadId] ?? "" };
        },
        spawn: async () => {
          spawnCount += 1;
          return { id: `thr_${spawnCount}` };
        },
      },
    },
  };
  return { bb: bb as never, debugLines, stopped };
}

describe("judge-verdict parser", () => {
  it("normalizes skipped, errored, empty and unrecognized answers to not_run", () => {
    expect(JUDGE_VERDICTS).toEqual(["pass", "rework", "block", "not_run"]);
    expect(parseJudgeVerdict({ skipped: true, skipReason: "below_threshold" }).verdict).toBe("not_run");
    expect(parseJudgeVerdict({ error: new Error("timeout") }).verdict).toBe("not_run");
    expect(parseJudgeVerdict({ output: "   " }).verdict).toBe("not_run");
    expect(parseJudgeVerdict({ output: "no json block" }).verdict).toBe("not_run");
  });

  it("parses unified status verdicts through the single closed vocabulary", () => {
    const pass = parseJudgeVerdict({
      output: '```json\n{"status":"pass","summary":"ok","findings":[],"evidence":"checked"}\n```',
    });
    expect(pass.verdict).toBe("pass");

    const rework = parseJudgeVerdict({
      output: '```json\n{"status":"rework","summary":"fix","findings":[{"file":"src/a.ts","line":3,"severity":"high","evidence":"missing check"}],"evidence":"read a.ts"}\n```',
    });
    expect(rework.verdict).toBe("rework");
  });
});

describe("judge-runner", () => {
  it("formats DEBUG judge.run log lines safely even if bb.log.debug is missing", () => {
    const seen: string[] = [];
    logJudgeVerdict({ log: { debug: (m: string) => seen.push(m) } } as never, "code-critic", "rework", Date.now() - 5);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^judge\.run role=code-critic verdict=rework ms=\d+$/);

    expect(() => logJudgeVerdict({ log: { info: vi.fn() } } as never, "code-critic", "pass", Date.now())).not.toThrow();
  });

  it("rotates across fallback pairs, stops timed-out active threads, and emits judge.run", async () => {
    const { bb, debugLines, stopped } = stubBb({
      threadStatuses: { thr_1: ["idle", "active"] },
      failOutputOn: new Set(["thr_1"]),
      outputs: { thr_2: "rework" },
    });
    const res = await runJudge({
      bb,
      db: {} as never,
      projectId: "p1",
      runId: "r1",
      hostId: "h1",
      role: "plan-critic",
      taskTitle: "Task 1",
      pairs: [
        { providerId: "codex", model: "gpt-6.1-sol" },
        { providerId: "claude-code", model: "claude-opus-5-5" },
      ],
      effort: "medium",
      tier: "standard",
      errorPrefix: "critique",
      timeoutCode: "critique_thread_timeout",
      placement: { hostId: "h1", parentThreadId: "pm_1", title: "Plan critique", role: "plan-critic" } as never,
      helperPolicy: { mode: "inherit", policy: null } as never,
      environment: { type: "sandbox" },
      isRetryable: (_c, msg) => msg.includes("critique_output_empty"),
      stepsForRound: () => [{ prompt: "review", pluginMetadata: { role: "plan-critic" }, parse: (_tid, raw) => raw }],
      toVerdict: (results) => (results[0] === "rework" ? "rework" : "pass"),
    });
    expect(res.status).toBe("ok");
    expect(res.verdict).toBe("rework");
    expect(stopped).toEqual(["thr_1"]);
    expect(debugLines).toHaveLength(1);
    expect(debugLines[0]).toMatch(/^judge\.run role=plan-critic verdict=rework ms=\d+$/);
  });

  it("runHelperPrompt shares spawn/wait without emitting judge.run", async () => {
    const { bb, debugLines } = stubBb({ outputs: { thr_1: "summary json" } });
    const res = await runHelperPrompt({
      bb,
      db: {} as never,
      projectId: "p1",
      runId: "r1",
      hostId: "h1",
      role: "pm-reader",
      taskTitle: "PM Read",
      pairs: [{ providerId: "codex", model: "gpt-6.1-sol" }],
      effort: "medium",
      tier: "standard",
      errorPrefix: "pm_read",
      timeoutCode: "pm_read_timeout",
      placement: { hostId: "h1", parentThreadId: "pm_1", title: "PM Read", role: "pm-reader" } as never,
      helperPolicy: { mode: "inherit", policy: null } as never,
      environment: { type: "sandbox" },
      stepsForRound: () => [{ prompt: "summarize", pluginMetadata: { role: "pm-reader" }, parse: (_tid, raw) => raw }],
    });
    expect(res.status).toBe("ok");
    expect(debugLines).toEqual([]);
  });
});

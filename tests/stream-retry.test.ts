import { expect, it } from "vitest";
import { createFakePluginHost, makeTurnFailedEvent } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { createAttempt, createRun, openDatabase, transitionAttempt } from "../src/database";
import { MAX_STREAM_RETRY_ATTEMPTS, streamRetryDecision } from "../src/stream-retry";
import { nativeSelectionSchema } from "../src/native-session";

const streamError = {
  category: "stream-disconnected" as const,
  httpStatusCode: null,
  providerCode: null,
};

it("retries stream-disconnected and connection-failed, and leaves rate limits to provider-retry", () => {
  expect(streamRetryDecision({ attemptNumber: 1, errorInfo: streamError })).toEqual({ kind: "retry", delayMs: 3_000 });
  expect(streamRetryDecision({
    attemptNumber: 1,
    errorInfo: { category: "connection-failed", httpStatusCode: null, providerCode: null },
  }).kind).toBe("retry");
  expect(streamRetryDecision({
    attemptNumber: 1,
    errorInfo: { category: "rate-limit", httpStatusCode: 429, providerCode: null },
  })).toEqual({ kind: "decline", reason: "provider-retry-owns" });
  expect(streamRetryDecision({
    attemptNumber: 1,
    errorInfo: { category: "overloaded", httpStatusCode: 529, providerCode: null },
  })).toEqual({ kind: "decline", reason: "provider-retry-owns" });
  expect(streamRetryDecision({ attemptNumber: 1, errorInfo: null })).toEqual({ kind: "decline", reason: "not-retryable" });
  expect(streamRetryDecision({
    attemptNumber: 1,
    errorInfo: null,
    detail: "Error: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)",
  })).toEqual({ kind: "retry", delayMs: 3_000 });
  expect(streamRetryDecision({ attemptNumber: MAX_STREAM_RETRY_ATTEMPTS, errorInfo: streamError })).toEqual({ kind: "decline", reason: "attempts-exhausted" });
});

it("retries an owned native thread by reference and ignores a foreign chat", async () => {
  const retries: Array<{ threadId: string; turnRequestId?: string; reason?: string }> = [];
  const fake = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: {
      threads: {
        retry: async (args) => {
          retries.push(args);
          return { ok: true as const, delivery: "sent" as const, attempt: 2, turnRequestId: String(args.turnRequestId ?? "") };
        },
        getPluginMetadata: async () => ({}),
      },
    },
  });
  await plugin(fake.bb);
  await fake.bb.storage.kv.set("native-thread:thr_owned", nativeSelectionSchema.parse({
    token: "11111111-1111-4111-8111-111111111111",
    projectId: "project_a",
    agentId: "dev-orchestrator",
    profileMode: "installed",
    agentsJson: null,
    sourceHash: null,
    createdAt: 1,
  }));

  await fake.harness.behavior.emitThreadEvent("turn.failed", makeTurnFailedEvent({
    threadId: "thr_foreign",
    requestId: "creq_foreign",
    errorInfo: streamError,
  }));
  expect(retries).toEqual([]);

  await fake.harness.behavior.emitThreadEvent("turn.failed", makeTurnFailedEvent({
    threadId: "thr_owned",
    requestId: "creq_owned",
    errorInfo: streamError,
    attemptNumber: 1,
  }));
  expect(retries).toEqual([expect.objectContaining({
    threadId: "thr_owned",
    turnRequestId: "creq_owned",
    reason: "Lane Pilot: retry the same turn after a dropped stream",
  })]);
  await fake.harness.lifecycle.dispose();
});

it("retries an owned thread when Claude reports HTTP/2 CANCEL without a stream category", async () => {
  const retries: string[] = [];
  const fake = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: {
      threads: {
        retry: async (args: { threadId: string }) => {
          retries.push(args.threadId);
          return { ok: true as const, delivery: "sent" as const, attempt: 2, turnRequestId: "creq_http2" };
        },
        getPluginMetadata: async () => ({ role: "pm", lanePilotRunId: "lprun_http2" }),
        events: {
          list: async () => [{
            type: "provider/error",
            seq: 2,
            data: { message: "Error: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)" },
          }],
        },
      },
    },
  });
  await plugin(fake.bb);
  await fake.harness.behavior.emitThreadEvent("turn.failed", makeTurnFailedEvent({
    threadId: "thr_http2",
    requestId: "creq_http2",
    errorInfo: null,
  }));
  expect(retries).toEqual(["thr_http2"]);
  await fake.harness.lifecycle.dispose();
});

it("retries a Lane Pilot helper thread identified by plugin metadata", async () => {
  const retries: string[] = [];
  const fake = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: {
      threads: {
        retry: async (args: { threadId: string }) => {
          retries.push(args.threadId);
          return { ok: true as const, delivery: "sent" as const, attempt: 2, turnRequestId: "creq_helper" };
        },
        getPluginMetadata: async () => ({ role: "writer", lanePilotRunId: "lprun_1" }),
      },
    },
  });
  await plugin(fake.bb);
  await fake.harness.behavior.emitThreadEvent("turn.failed", makeTurnFailedEvent({
    threadId: "thr_writer",
    requestId: "creq_helper",
    errorInfo: streamError,
  }));
  expect(retries).toEqual(["thr_writer"]);
  await fake.harness.lifecycle.dispose();
});

it("does not retry a writer the user canceled", async () => {
  const retries: string[] = [];
  const fake = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: {
      threads: {
        retry: async (args: { threadId: string }) => {
          retries.push(args.threadId);
          return { ok: true as const, delivery: "sent" as const, attempt: 2, turnRequestId: "creq_cancel" };
        },
        getPluginMetadata: async () => ({ role: "writer", lanePilotRunId: "lprun_1", attemptId: "attempt-cancel" }),
      },
    },
  });
  await plugin(fake.bb);
  const db = openDatabase(fake.bb);
  createRun(db, "lprun_1", "project_a");
  createAttempt(db, { id: "attempt-cancel", runId: "lprun_1", taskId: "t" });
  transitionAttempt(db, "attempt-cancel", "running", { threadId: "thr_cancel" });
  transitionAttempt(db, "attempt-cancel", "cancel_requested", { threadId: "thr_cancel" });
  await fake.harness.behavior.emitThreadEvent("turn.failed", makeTurnFailedEvent({
    threadId: "thr_cancel",
    requestId: "creq_cancel",
    errorInfo: streamError,
  }));
  expect(retries).toEqual([]);
  await fake.harness.lifecycle.dispose();
});

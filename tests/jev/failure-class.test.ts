import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/database";
import { classifyFailure } from "../../src/failure-class";
import { judgedFailureClass } from "../../src/jev/failure-class-model";
import { failureClassJudgment } from "../../src/jev/judgments/failure-class";
import { createJev } from "@lane-pilot/jev";
import type { JevClient } from "@lane-pilot/jev";

// J-4: a reason the regular expressions have no confident match for goes to Jev; `shadow` records, `active` acts, the rules' class is the fallback.
const UNKNOWN = "ssh: connect to host 10.8.0.1 port 22: Operation timed out while syncing the worktree";

function setup(top: string, p: number) {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const asked: unknown[] = [];
  const client: JevClient = {
    breaker: () => ({ open: false, failures: 0 }),
    async call(request) {
      asked.push(request.state);
      const rest = (1 - p) / 5;
      const probabilities = Object.fromEntries(["task", "provider", "harness", "infra", "merge", "contract"].map((name) => [name, name === top ? p : rest]));
      return { ok: true, model: "jev-test", usage: { input_tokens: 500, output_tokens: 20 }, latencyMs: 80, attempts: 1,
        answers: { [Object.keys(request.questions)[0]!]: { type: "choice", choice: top, probabilities, confidence: 0.9 } } };
    },
  };
  const jev = createJev({ client, db });
  const deps = (modes: string) => ({ jev: () => jev, settings: async () => ({ "jev.modes": `failure.class=${modes}` }), projectId: "proj", runId: "run" });
  return { db, asked, deps };
}

describe("failureClass: which reasons the rules are sure of", () => {
  it("is confident for every reason Lane Pilot writes and for a red check, and not for a message nobody has seen", () => {
    expect(classifyFailure("blocked", "internal_error: boom")).toEqual({ cls: "harness", confident: true });
    expect(classifyFailure("validation_failed", "verification failed (npm test): 2 failed")).toEqual({ cls: "task", confident: true });
    expect(classifyFailure("validation_failed", "writer changed paths outside owns_paths: src/a.ts")).toEqual({ cls: "task", confident: true });
    expect(classifyFailure("timeout", "wait timeout")).toEqual({ cls: "provider", confident: true });
    expect(classifyFailure("validation_failed", UNKNOWN)).toEqual({ cls: "task", confident: false });
  });
});

describe("J-4 failure.class", () => {
  it("takes a clear class and falls back to task otherwise", () => {
    const answers = (top: string, p: number) => ({ side: { type: "choice" as const, choice: top, confidence: 0.9, probabilities: { [top]: p, task: 1 - p } } });
    const t = { min_p: 0.7, min_margin: 0.3 };
    expect(failureClassJudgment.decide(answers("infra", 0.9), t, { state: "x", reason: "y" })).toEqual({ decision: { cls: "infra" } });
    expect(failureClassJudgment.decide(answers("infra", 0.6), t, { state: "x", reason: "y" })).toEqual({ decision: { cls: "task" } });
    expect(failureClassJudgment.fallback({ state: "x", reason: "y" })).toEqual({ cls: "task" });
  });

  it("never asks about a reason the rules are sure of", async () => {
    const { asked, deps } = setup("infra", 0.95);
    expect(await judgedFailureClass(deps("active"), "blocked", "internal_error: boom")).toBe("harness");
    expect(await judgedFailureClass(deps("active"), "validation_failed", "verification failed (npm test): 2 failed")).toBe("task");
    expect(asked).toEqual([]);
  });

  it("shadow (the default for a new judgment): asks, records, and the rules' class stays", async () => {
    const { db, asked, deps } = setup("infra", 0.95);
    expect(await judgedFailureClass(deps("shadow"), "validation_failed", UNKNOWN, "T1")).toBe("task");
    expect(asked).toHaveLength(1);
    const receipt = db.prepare("SELECT judgment, mode, decided_by, decision, subject FROM lane_pilot_jev_receipt").get() as Record<string, unknown>;
    expect(receipt).toMatchObject({ judgment: "failure.class", mode: "shadow", decided_by: "fallback", subject: "T1" });
    expect(String(receipt.decision)).toBe("infra");
  });

  it("is shadow when the project sets nothing", async () => {
    const { db, deps } = setup("infra", 0.95);
    const none = { ...deps("shadow"), settings: async () => ({}) };
    expect(await judgedFailureClass(none, "validation_failed", UNKNOWN)).toBe("task");
    expect((db.prepare("SELECT mode FROM lane_pilot_jev_receipt").get() as { mode: string }).mode).toBe("shadow");
  });

  it("active: Jev's clear class is used; an unclear one is the rules' task", async () => {
    const clear = setup("infra", 0.95);
    expect(await judgedFailureClass(clear.deps("active"), "validation_failed", UNKNOWN)).toBe("infra");
    const unclear = setup("infra", 0.45);
    expect(await judgedFailureClass(unclear.deps("active"), "validation_failed", UNKNOWN)).toBe("task");
  });

  it("off, or no Jev at all, is the rules' class and asks nothing", async () => {
    const { asked, deps } = setup("infra", 0.95);
    expect(await judgedFailureClass(deps("off"), "validation_failed", UNKNOWN)).toBe("task");
    expect(await judgedFailureClass({ ...deps("active"), jev: () => null }, "validation_failed", UNKNOWN)).toBe("task");
    expect(asked).toEqual([]);
  });
});

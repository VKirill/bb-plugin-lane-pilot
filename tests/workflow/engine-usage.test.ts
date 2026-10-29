import { describe, expect, it } from "vitest";
import { engineOn, journalDb, wf } from "./engine-helpers";

// The 2026-10-29 full-code audit (Аудит GPT), probe A-003, kept as a regression.
describe("what a step spent", () => {
  it("charges the failed attempt before a retry that succeeds, once", async () => {
    const db = journalDb(); let attempt = 0;
    const engine = engineOn(db, {});
    engine.register("write", { run: async () => {
      if (++attempt === 1) throw Object.assign(new Error("model answer invalid"), { usage: { tokens: 100, costUsd: 1 } });
      return { output: { text: "ok" }, usage: { tokens: 5, costUsd: 0.05 } };
    } });
    const flow = wf({ nodes: [{ id: "write", type: "action", action: "write", maxAttempts: 2, output: [{ name: "text", type: "string" }] }],
      edges: [{ from: "start", to: "write" }, { from: "write", to: "end", with: { result: "write.text" } }] });
    try {
      const run = engine.start({ workflow: flow, inputs: { query: "q" } });
      expect((await run.done).status).toBe("succeeded");
      const row = engine.journal.getRun(run.runId)!;
      expect([row.tokens_used, row.cost_micro_usd]).toEqual([105, 1_050_000]);
    } finally { engine.dispose(); db.close(); }
  });

  it("charges every failed attempt of a step that fails", async () => {
    const db = journalDb();
    const engine = engineOn(db, {});
    engine.register("write", { run: async () => { throw Object.assign(new Error("model answer invalid"), { usage: { tokens: 10, costUsd: 0.1 } }); } });
    const flow = wf({ nodes: [{ id: "write", type: "action", action: "write", maxAttempts: 3, output: [{ name: "text", type: "string" }] }],
      edges: [{ from: "start", to: "write" }, { from: "write", to: "end", with: { result: "write.text" } }] });
    try {
      const run = engine.start({ workflow: flow, inputs: { query: "q" } });
      expect((await run.done).status).toBe("failed");
      expect(engine.journal.getRun(run.runId)!.tokens_used).toBe(30);
    } finally { engine.dispose(); db.close(); }
  });

  it("keeps a vote's unknown spend unknown, so the budget does not read it as free", async () => {
    const db = journalDb(); const engine = engineOn(db, {});
    engine.register("agent", { run: async () => ({ output: { text: "ok", handoff: "checked" }, usage: { unknown: true } }) });
    const flow = wf({ budget: { maxTokens: 1 }, nodes: [{ id: "vote", type: "agent", role: "auditor", uses: "agent", prompt: "review", votes: 3, out: [{ name: "text", type: "string" }] }],
      edges: [{ from: "start", to: "vote" }, { from: "vote", to: "end", with: { result: "vote.text" } }] });
    try {
      const run = engine.start({ workflow: flow, inputs: { query: "q" } });
      await run.done;
      expect(engine.unknownUsageSteps(run.runId)).toHaveLength(1);
    } finally { engine.dispose(); db.close(); }
  });
});

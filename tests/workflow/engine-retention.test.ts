import { expect, it } from "vitest";
import { engineOn, journalDb, ok, wf } from "./engine-helpers";

// The 2026-10-29 full-code audit (Аудит GPT), A-010: finished runs are let go; the newest ones stay for a re-run.
it("holds a bounded number of finished runs in memory, and a re-run of an old one still works", async () => {
  const db = journalDb();
  const engine = engineOn(db, { search: ok(() => ({ items: [], count: 0, kind: "fresh" })), write: ok(() => ({ text: "done" })) });
  try {
    const ids: string[] = [];
    for (let n = 0; n < 100; n++) { const run = engine.start({ workflow: wf(), inputs: { query: String(n) }, runtime: { payload: "x".repeat(1024) } }); ids.push(run.runId); await run.done; }
    const held = engine as unknown as { compiledRuns: Map<string, unknown>; runtimes: Map<string, unknown>; aborts: Map<string, unknown> };
    expect(held.aborts.size).toBe(0);
    expect(held.compiledRuns.size).toBeLessThanOrEqual(64);
    expect(held.runtimes.size).toBeLessThanOrEqual(64);
    expect(await engine.rerunNode(ids[0]!, "write")).toMatchObject({ ok: true });
    await engine.idle();
    expect(engine.get(ids[0]!)?.status).toBe("succeeded");
  } finally { engine.dispose(); db.close(); }
});

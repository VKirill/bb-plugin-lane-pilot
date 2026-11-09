import { describe, expect, it } from "vitest";
import { critiquePrompt } from "../../src/rooms/critique/critique";
import { ownerWordsOfRun } from "../../src/rooms/critique/server/owner-words";
import type { EventLike, ThreadLike } from "../../src/rooms/anamnesis/owner-messages";

const T = Date.UTC(2026, 10, 1, 12);
const pmThread: ThreadLike = { id: "thr_pm", projectId: "proj_a", createdAt: T - 1_000, visibility: "visible", parentThreadId: null, originPluginId: null, deletedAt: null };
const turn = (seq: number, at: number, text: string, data: Record<string, unknown> = {}): EventLike => ({
  seq, type: "client/turn/requested", createdAt: at,
  data: { initiator: "user", requestId: `r${seq}`, input: [{ type: "text", text }], ...data },
});

function world(events: EventLike[], options: { thread?: unknown; createdAt?: number; throwEvents?: boolean } = {}) {
  const db = { prepare: () => ({ get: () => ({ pm_thread_id: "thr_pm", created_at: options.createdAt ?? T }) }) };
  const bb = {
    log: { warn: () => {} },
    sdk: { threads: {
      get: async () => options.thread === undefined ? pmThread : options.thread,
      events: { list: async (query: { beforeSeq?: string; limit: string }) => {
        if (options.throwEvents) throw new Error("sdk down");
        const all = [...events].sort((a, b) => b.seq - a.seq).filter((event) => query.beforeSeq === undefined || event.seq < Number(query.beforeSeq));
        return all.slice(0, Number(query.limit));
      } },
    } },
  };
  return { bb: bb as never, db: db as never };
}

describe("critiquePrompt owner words", () => {
  it("always asks for the «Proposes:» paraphrase and adds the section only when owner words are given", () => {
    for (const prompt of [critiquePrompt({ plan: "p", task: {} }), critiquePrompt({ plan: "p", task: {}, ownerWords: [] })]) {
      expect(prompt).toContain("Proposes:");
      expect(prompt).not.toContain("OWNER'S WORDS");
    }
    const prompt = critiquePrompt({ plan: "p", task: {}, ownerWords: ["add a nightly export", "with a csv download"] });
    expect(prompt).toContain("OWNER'S WORDS");
    expect(prompt).toContain("> add a nightly export");
    expect(prompt).toContain("> with a csv download");
    expect(prompt).toContain("owner intent");
    expect(prompt).toContain("out_of_scope");
  });

  it("clips the quoted words to 3000 characters keeping the newest", () => {
    const oldest = `old-${"o".repeat(2_500)}`;
    const newest = `new-${"n".repeat(2_500)}`;
    const prompt = critiquePrompt({ plan: "p", task: {}, ownerWords: [oldest, newest] });
    expect(prompt).toContain(`> ${newest}`);
    expect(prompt).not.toContain(oldest);
    const single = critiquePrompt({ plan: "p", task: {}, ownerWords: [`x-${"y".repeat(4_000)}`] });
    expect(single).toContain(`> x-${"y".repeat(2_995)}`);
    expect(single).not.toContain("y".repeat(3_001));
  });
});

describe("ownerWordsOfRun", () => {
  it("returns the last 3 owner messages before the run's creation, newest last, ignoring other turns", async () => {
    const w = world([
      turn(1, T - 40_000, "first request"),
      turn(2, T - 30_000, "agent turn", { initiator: "agent" }),
      turn(3, T - 20_000, "a plugin relayed this", { senderThreadId: "thr_x" }),
      turn(4, T - 15_000, "second request"),
      turn(5, T - 10_000, "third request"),
      turn(6, T - 5_000, "fourth request"),
      turn(7, T + 5_000, "written after the run started"),
      turn(8, T, "same tick as the run"),
    ]);
    expect(await ownerWordsOfRun({ ...w, runId: "run_1" })).toEqual(["second request", "third request", "fourth request"]);
  });

  it("cuts at the task's creation when a run carries several dispatches", async () => {
    const w = world([turn(1, T - 30_000, "asked for task one"), turn(2, T + 10_000, "asked for task two"), turn(3, T + 30_000, "after task two")]);
    const db = { prepare: (sql: string) => ({ get: () => sql.includes("lane_pilot_task") ? { created_at: T + 20_000 } : { pm_thread_id: "thr_pm", created_at: T } }) };
    expect(await ownerWordsOfRun({ bb: w.bb, db: db as never, runId: "run_1", taskId: "task_2" })).toEqual(["asked for task one", "asked for task two"]);
  });

  it("returns [] when the SDK fails, the thread is not the owner's, or the run has no PM thread", async () => {
    expect(await ownerWordsOfRun({ ...world([turn(1, T - 1, "hi")], { throwEvents: true }), runId: "run_1" })).toEqual([]);
    expect(await ownerWordsOfRun({ ...world([turn(1, T - 1, "hi")], { thread: { ...pmThread, originPluginId: "lane-pilot" } }), runId: "run_1" })).toEqual([]);
    const noThread = { bb: world([]).bb, db: { prepare: () => ({ get: () => ({ pm_thread_id: null, created_at: T }) }) } as never };
    expect(await ownerWordsOfRun({ ...noThread, runId: "run_1" })).toEqual([]);
  });
});

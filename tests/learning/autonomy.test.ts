import { describe, expect, it } from "vitest";
import { createAutonomy, modelReviewPrompt, parseModelReview, MODEL_REVIEW_RUNS_PER_DAY } from "../../src/rooms/learning/autonomy";
import { createOps, type Kv } from "../../src/rooms/learning/ops";
import { DAY_MS, getItem, insertItem, reviewStats, type Item } from "../../src/rooms/learning/store";
import { NOW, config as configOf, database } from "./helpers";

function seed(db: ReturnType<typeof database>, count: number, judgedAt = NOW - 8 * DAY_MS) {
  for (let i = 0; i < count; i++) {
    db.prepare("INSERT INTO lane_pilot_learning_obs (id,thread_id,project_id,at,judged_at,source,chars,excerpt,state,jev_status,final_route) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(`thr_m:${i}:0`, "thr_m", "proj_1", NOW, judgedAt, "live", 40, `message ${i}`, "observed", "ok", i % 2 ? "learn" : "none");
  }
}

function harness(db: ReturnType<typeof database>, reply: (prompt: string) => string, options: { accept?: (id: string) => Promise<{ item: Item; run?: string }> } = {}) {
  const store = new Map<string, unknown>();
  const kv = { get: async (key: string) => store.get(key), set: async (key: string, value: unknown) => { store.set(key, value); } } as unknown as Kv;
  let config = configOf({ mode: "observe" });
  const ops = createOps({ db, kv, now: () => NOW, onConfig: (next) => { config = next; } });
  const sent: Array<[string, string]> = [], logs: string[] = [], prompts: string[] = [];
  const autonomy = createAutonomy({
    db, kv, config: () => config, status: () => ops.status(), configure: (words) => ops.configure(words),
    runModel: async (prompt) => { prompts.push(prompt); return reply(prompt); },
    decisions: { accept: options.accept ?? (async (id) => ({ item: { ...getItem(db, id)!, state: "accepted" } })) },
    pmThread: () => "thr_pm", sendToPm: async (thread, text) => { sent.push([thread, text]); }, now: () => NOW, log: (line) => logs.push(line),
  });
  return { autonomy, ops, sent, logs, prompts, config: () => config };
}

const allRight = (prompt: string) => JSON.stringify([...prompt.matchAll(/"id":"([^"]+)"/g)].map((match) => ({ id: match[1], correct: true })));

describe("learning without the owner", () => {
  it("reads only labels for the asked messages from a JSON reply", () => {
    const asked = new Set(["a", "b"]);
    expect(parseModelReview('Here: [{"id":"a","correct":true},{"id":"x","correct":false},{"id":"a","correct":false},{"id":"b","correct":false}]', asked))
      .toEqual([{ id: "a", correct: true }, { id: "b", correct: false }]);
    expect(parseModelReview("no json", asked)).toEqual([]);
    expect(parseModelReview('[{"id":"a"}]', asked)).toEqual([]);
  });

  it("a model checks the judges' decisions, and learning switches itself on with enough right ones", async () => {
    const db = database();
    seed(db, 60);
    const { autonomy, config, prompts, logs } = harness(db, allRight);
    expect(config().mode).toBe("observe");
    await autonomy.reviewTick();
    await autonomy.reviewTick();
    expect(prompts[0]).toContain("message");
    expect(modelReviewPrompt([])).toContain("JSON only");
    expect(reviewStats(db).reviewed).toBe(50);
    expect(config().mode).toBe("active");
    expect(logs.join("\n")).toMatch(/switched to active on evidence/);
  });

  it("stays observing when the model finds the judges wrong too often, and keeps to the runs a day", async () => {
    const db = database();
    seed(db, 200);
    const { autonomy, config, prompts } = harness(db, (prompt) => JSON.stringify([...prompt.matchAll(/"id":"([^"]+)"/g)].map((match, index) => ({ id: match[1], correct: index % 2 === 0 }))));
    for (let i = 0; i < MODEL_REVIEW_RUNS_PER_DAY + 2; i++) await autonomy.reviewTick();
    expect(prompts.length).toBeLessThanOrEqual(MODEL_REVIEW_RUNS_PER_DAY);
    expect(reviewStats(db).accuracy).toBeLessThan(0.8);
    expect(config().mode).toBe("observe");
  });

  it("accepts what waited for the owner's yes and hands a global preference to the PM to save", async () => {
    const db = database();
    const base: Item = { id: "lrn_g", obsId: "thr_a:1:0", projectId: "proj_1", threadId: "thr_a", kind: "preference", text: "Always answer in Russian", audience: "both", reach: "owner", dueAt: null,
      state: "pending_owner", target: "bb-memory", evidence: "owner message thr_a:1:0", duplicateOf: null, confirmations: 0, note: null, createdAt: NOW, decidedAt: null, announcedAt: null };
    insertItem(db, base);
    insertItem(db, { ...base, id: "lrn_d", kind: "deadline", reach: "project", target: "reminder", text: "Release on Friday" });
    const { autonomy, sent } = harness(db, allRight, {
      accept: async (id) => ({ item: { ...getItem(db, id)!, state: "accepted" }, ...(id === "lrn_g" ? { run: "bb memory add --scope global" } : {}) }),
    });
    const settled = await autonomy.settleWaiting();
    expect(settled.map((row) => row.id).sort()).toEqual(["lrn_d", "lrn_g"]);
    expect(sent).toHaveLength(1);
    expect(sent[0]![0]).toBe("thr_pm");
    expect(sent[0]![1]).toMatch(/^Lane Pilot: .*bb memory add --scope global/s);
  });
});

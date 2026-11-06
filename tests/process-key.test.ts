import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createJev, setJevForTests, type JevClient } from "@lane-pilot/jev";
import { openDatabase } from "../src/rooms/storage/database";
import { PROCESS_KEY_JUDGMENT_ID, chooseProcessKey, nearestKeys, pairwiseF1, processKeyJudgment } from "../src/rooms/errands";
import { processKeyEval, runErrandsCli, wordJudge } from "../src/rooms/errands";
import gold from "./fixtures/errand-gold.json";

const KNOWN = [
  { key: "invoice|create-and-send", titles: ["Счёт для ООО Ромашка", "Новый счёт и отправка клиенту"] },
  { key: "yandex-cloud|ticket-reply", titles: ["Ответ в тикет Yandex Cloud VP814113214", "Ответ в тикет клиенту в кабинете"] },
  { key: "magicseo|api-recon", titles: ["Разведка API MagicSEO", "Карта эндпоинтов MagicSEO"] },
  { key: "bb-plugin|ship-and-check", titles: ["Выложить плагин и проверить CI", "Релиз lane-pilot и проверка сборки"] },
];

/** A Jev whose fake client answers every choice question with `top` at 0.9 (the rest share 0.1). */
function jevPicking(top: string) {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const client: JevClient = {
    breaker: () => ({ open: false, failures: 0 }),
    async call(request) {
      // judgeMany batches questions as "<index>::<id>"; the pick question is the one ending in ::key.
      const qid = Object.keys(request.questions).find((id) => id === "key" || id.endsWith("::key"))!;
      const keys = Object.keys((request.questions[qid] as { criteria: Record<string, unknown> }).criteria);
      const rest = keys.filter((key) => key !== top);
      const probabilities = Object.fromEntries([[top, 0.9], ...rest.map((key) => [key, rest.length ? 0.1 / rest.length : 0])]);
      return { ok: true, model: "jev-test", usage: { input_tokens: 500, output_tokens: 20 }, latencyMs: 50, attempts: 1,
        answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: "choice" as const, choice: top, probabilities, confidence: 0.9 }])) };
    },
  };
  const jev = createJev({ client, db });
  setJevForTests(jev);
  return { db, jev };
}
const receipts = (db: ReturnType<typeof openDatabase>) => db.prepare("SELECT judgment, mode FROM lane_pilot_jev_receipt").all() as Array<{ judgment: string; mode: string }>;
afterEach(() => setJevForTests(null));

const ACTIVE = { settings: { "episodes.process_key": "active" } };

describe("nearestKeys: the 8 known keys nearest by word stems", () => {
  it("ranks the right key first on three errands", () => {
    expect(nearestKeys("invoice|create-and-send", "Составь счёт и отправь его клиенту", KNOWN)[0]!.key).toBe("invoice|create-and-send");
    expect(nearestKeys("magicseo|api-recon", "Проверь эндпоинты API MagicSEO и собери карту", KNOWN)[0]!.key).toBe("magicseo|api-recon");
    expect(nearestKeys("bb-plugin|ship-and-check", "Выложи новую версию плагина и проверь CI", KNOWN)[0]!.key).toBe("bb-plugin|ship-and-check");
  });

  it("returns nothing when no known key shares a stem, and nothing for an empty known list", () => {
    expect(nearestKeys("zzz|qqq", "абракадабра фыва", KNOWN)).toEqual([]);
    expect(nearestKeys("invoice|create-and-send", "Счёт клиенту", [])).toEqual([]);
  });

  it("caps the list at n, nearest first", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ key: `app|feature-${i}`, titles: [`feature map part ${i} of the app`] }));
    const near = nearestKeys("app|feature-map", "feature map of the app", many, 8);
    expect(near).toHaveLength(8);
    expect(near.every((entry, i) => i === 0 || near[i - 1]!.score >= entry.score)).toBe(true);
  });
});

describe("chooseProcessKey: candidate → Jev pick among the nearest keys", () => {
  it("is registered in shadow with a min_p threshold and the candidate as its fallback", () => {
    expect(processKeyJudgment).toMatchObject({ id: PROCESS_KEY_JUDGMENT_ID, version: 1, defaultMode: "shadow" });
    expect(processKeyJudgment.thresholds.min_p!.default).toBe(0.6);
    expect(processKeyJudgment.fallback({ candidate: "new|key", title: "t", options: [] })).toEqual({ key: "new|key", how: "fallback" });
  });

  it("no known keys or nothing similar: the candidate is a new key and Jev is not asked", async () => {
    const { db } = jevPicking("invoice|create-and-send");
    expect(await chooseProcessKey({ candidate: "solo|thing", title: "Разовое дело", known: [], judge: wordJudge() })).toEqual({ key: "solo|thing", how: "new" });
    expect(await chooseProcessKey({ candidate: "zzz|qqq", title: "абракадабра фыва", known: KNOWN, judge: wordJudge() })).toEqual({ key: "zzz|qqq", how: "new" });
    expect(receipts(db)).toEqual([]);
  });

  it("shadow (the default): the candidate stands and the receipt keeps what Jev would have picked", async () => {
    const { db } = jevPicking("invoice|create-and-send");
    const pick = await chooseProcessKey({ candidate: "app|invoices", title: "Составь счёт и отправь клиенту", known: KNOWN });
    expect(pick).toEqual({ key: "app|invoices", how: "new" });
    expect(receipts(db)).toEqual([{ judgment: PROCESS_KEY_JUDGMENT_ID, mode: "shadow" }]);
  });

  it("active: a confident Jev pick sets the key; none_of_these or a pick under min_p leaves the candidate as new", async () => {
    jevPicking("invoice|create-and-send");
    expect(await chooseProcessKey({ candidate: "app|invoices", title: "Составь счёт и отправь клиенту", known: KNOWN, ctx: ACTIVE })).toEqual({ key: "invoice|create-and-send", how: "jev" });
    jevPicking("none_of_these");
    expect(await chooseProcessKey({ candidate: "app|invoices", title: "Составь счёт и отправь клиенту", known: KNOWN, ctx: ACTIVE })).toEqual({ key: "app|invoices", how: "new" });
  });

  it("active but the judgment itself is off in jev.modes: the deterministic answer stands", async () => {
    jevPicking("invoice|create-and-send");
    const ctx = { settings: { "episodes.process_key": "active", "jev.modes": "errand.process_key=off" } };
    expect(await chooseProcessKey({ candidate: "app|invoices", title: "Составь счёт и отправь клиенту", known: KNOWN, ctx })).toEqual({ key: "app|invoices", how: "new" });
  });

  it("Jev down or failing: an exact candidate match counts, else the candidate stands as fallback", async () => {
    setJevForTests(null);
    expect(await chooseProcessKey({ candidate: "invoice|create-and-send", title: "Счёт клиенту", known: KNOWN })).toEqual({ key: "invoice|create-and-send", how: "fallback" });
    expect(await chooseProcessKey({ candidate: "app|invoices", title: "Счёт клиенту", known: KNOWN })).toEqual({ key: "app|invoices", how: "fallback" });
    const throwing = { enabled: () => true, judge: async () => { throw new Error("provider down"); } } as never;
    expect(await chooseProcessKey({ candidate: "app|invoices", title: "Счёт клиенту", known: KNOWN, judge: throwing })).toEqual({ key: "app|invoices", how: "fallback" });
  });
});

describe("pairwiseF1: pairs of errands sharing a key", () => {
  it("is 1.0 on identical keys, 0.5 when half the pairs agree, 0 on disjoint keys", () => {
    const goldRows = [{ id: "a", key: "k1|x" }, { id: "b", key: "k1|x" }, { id: "c", key: "k2|y" }, { id: "d", key: "k2|y" }];
    expect(pairwiseF1(goldRows, goldRows).f1).toBe(1);
    // Predicted keeps pair a-b but pairs c with a new id e instead of d: one of two pairs agrees.
    const half = [{ id: "a", key: "k1|x" }, { id: "b", key: "k1|x" }, { id: "c", key: "k3|z" }, { id: "e", key: "k3|z" }];
    const mid = pairwiseF1(goldRows, half);
    expect(mid.pairs).toEqual({ gold: 2, predicted: 2, both: 1 });
    expect(mid.f1).toBe(0.5);
    const apart = [{ id: "a", key: "k3|z" }, { id: "b", key: "k4|w" }, { id: "c", key: "k5|v" }, { id: "d", key: "k6|u" }];
    expect(pairwiseF1(goldRows, apart).f1).toBe(0);
  });

  it("one-off|… keys are singletons: same key on two rows makes no pair", () => {
    const rows = [{ id: "a", key: "one-off|0" }, { id: "b", key: "one-off|0" }];
    const score = pairwiseF1(rows, rows);
    expect(score.pairs).toEqual({ gold: 0, predicted: 0, both: 0 });
  });
});

describe("process-key eval over the gold set", () => {
  it("runs chooseProcessKey over errand-gold.json and reports the word-only baseline F1", async () => {
    const result = await processKeyEval(gold.rows, wordJudge());
    expect(result.n).toBe(132);
    expect(result.predicted).toHaveLength(132);
    expect(Object.values(result.how).reduce((sum, count) => sum + count, 0)).toBe(132);
    expect(result.f1).toBeGreaterThanOrEqual(0);
    expect(result.f1).toBeLessThanOrEqual(1);
  });

  it("the CLI prints the baseline and --json returns the full report", async () => {
    const text = await runErrandsCli(["process-key-eval"]);
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("process-key eval: 132 errands");
    expect(text.stdout).toContain("pairwise F1");
    const json = await runErrandsCli(["process-key-eval", "--json"]);
    const report = JSON.parse(json.stdout!) as { n: number; f1: number };
    expect(report.n).toBe(132);
    expect(report.f1).toBeGreaterThanOrEqual(0);
  });

  it("usage: an unknown errands subcommand exits 1", async () => {
    expect((await runErrandsCli(["bogus"])).exitCode).toBe(1);
  });
});

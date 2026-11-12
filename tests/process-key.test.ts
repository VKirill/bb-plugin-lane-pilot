import { describe, expect, it } from "vitest";
import { chooseProcessKey, nearestKeys, pairwiseF1 } from "../src/rooms/errands";

const KNOWN = [
  { key: "invoice|create-and-send", titles: ["Счёт для ООО Ромашка", "Новый счёт и отправка клиенту"] },
  { key: "yandex-cloud|ticket-reply", titles: ["Ответ в тикет Yandex Cloud VP814113214", "Ответ в тикет клиенту в кабинете"] },
  { key: "magicseo|api-recon", titles: ["Разведка API MagicSEO", "Карта эндпоинтов MagicSEO"] },
  { key: "bb-plugin|ship-and-check", titles: ["Выложить плагин и проверить CI", "Релиз lane-pilot и проверка сборки"] },
];

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

describe("chooseProcessKey: the candidate stands", () => {
  it("no known keys or nothing similar: the candidate is a new key", async () => {
    expect(await chooseProcessKey({ candidate: "solo|thing", title: "Разовое дело", known: [] })).toEqual({ key: "solo|thing", how: "new" });
    expect(await chooseProcessKey({ candidate: "zzz|qqq", title: "абракадабра фыва", known: KNOWN })).toEqual({ key: "zzz|qqq", how: "new" });
  });

  it("something similar is known: the candidate still stands, marked as fallback", async () => {
    expect(await chooseProcessKey({ candidate: "invoice|create-and-send", title: "Счёт клиенту", known: KNOWN })).toEqual({ key: "invoice|create-and-send", how: "fallback" });
    expect(await chooseProcessKey({ candidate: "app|invoices", title: "Счёт клиенту", known: KNOWN })).toEqual({ key: "app|invoices", how: "fallback" });
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

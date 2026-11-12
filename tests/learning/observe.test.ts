import { describe, expect, it } from "vitest";
import { createObserver, prefilterReason } from "../../src/rooms/learning/observe";
import { getObservation, usageToday } from "../../src/rooms/learning/store";
import { NOW, config, database, message } from "./helpers";

function observer(options: { cfg?: Parameters<typeof config>[0] } = {}) {
  const db = database();
  const value = createObserver({ db, now: () => NOW, config: async () => config(options.cfg), prevReply: async () => "Готово, окно добавил." });
  return { db, ...value };
}
const handle = (o: ReturnType<typeof observer>, text: string, id?: string) => o.observe(message(text, id ? { id } : {}), { live: true });

describe("the hook on owner messages (T1): a rule-based pre-filter, no model", () => {
  it("keeps an owner message as a candidate with its masked text and the agent's previous reply", async () => {
    const o = observer();
    const row = (await handle(o, "Зачем такое окно? Убери его, почта a@b.io"))!;
    expect(row).toMatchObject({ state: "candidate", skipReason: null });
    const stored = getObservation(o.db, row.id)!;
    expect(stored.body).toContain("[email]");
    expect(stored.body).not.toContain("a@b.io");
    expect(stored.prev).toBe("Готово, окно добавил.");
    expect(stored.excerpt).toContain("Зачем такое окно");
  });

  it("drops machine text (the PM prompt) before anything is kept", async () => {
    const o = observer();
    const machine = "You are the Lane Pilot PM in the selected role.\nRun id: lprun_abc123.";
    expect(prefilterReason(machine)).toBe("machine");
    const row = (await handle(o, machine))!;
    expect(row).toMatchObject({ state: "skipped", skipReason: "machine", body: null });
  });

  it("drops acknowledgements, tiny and pasted messages, and a message it saw before", async () => {
    const o = observer();
    expect(await handle(o, "ок")).toMatchObject({ state: "skipped", skipReason: "short" });
    expect(await handle(o, "Давай!")).toMatchObject({ skipReason: "short" });
    expect(await handle(o, "x".repeat(13_000))).toMatchObject({ skipReason: "pasted" });
    const first = await handle(o, "Запусти тесты и покажи результат прогона", "thr_a:900:0");
    expect(first).toMatchObject({ state: "candidate" });
    expect(await handle(o, "Запусти тесты и покажи результат прогона", "thr_a:900:0")).toBeNull();
  });

  it("stops keeping candidates at the daily cap", async () => {
    const o = observer({ cfg: { dailyCandidateCap: 2 } });
    await handle(o, "Запусти тесты и покажи результат прогона");
    await handle(o, "Поправь заголовок на главной странице");
    expect(await handle(o, "Добавь тест на пустой список")).toMatchObject({ state: "skipped", skipReason: "cap" });
    expect(usageToday(o.db, NOW).candidates).toBe(2);
  });

  it("does nothing at all when switched off", async () => {
    const o = observer({ cfg: { enabled: false } });
    expect(await handle(o, "Зачем такое окно? Убери")).toBeNull();
    expect(o.db.prepare("SELECT count(*) AS n FROM lane_pilot_learning_obs").get()).toEqual({ n: 0 });
  });

  it("never keeps the text of a sensitive message", async () => {
    const o = observer();
    const secret = (await handle(o, "У меня ребёнок болеет, поэтому отвечай мне только вечером"))!;
    expect(secret).toMatchObject({ sensitive: true, excerpt: null, body: null, state: "observed" });
  });

  it("subscribes as one consumer and survives a message it cannot record", async () => {
    const o = observer();
    await o.consumer.handle([message("Зачем такое окно? Убери"), message("Запусти тесты и покажи результат")], { live: true });
    expect(o.db.prepare("SELECT count(*) AS n FROM lane_pilot_learning_obs").get()).toEqual({ n: 2 });
    expect(o.consumer.name).toBe("learning");
  });
});

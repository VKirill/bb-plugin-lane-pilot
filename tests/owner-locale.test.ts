import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import {
  councilOwnerForm,
  OWNER_RESOLVED_LOCALE_KEY,
  ownerLocale,
  SELF_REPAIR_GO_AHEAD_EN,
  SELF_REPAIR_LEAVE_EN,
  selfRepairOwnerForm,
  workflowHumanDetail,
  englishSelfRepairChoice,
} from "../src/rooms/relay/server/owner-locale";

function kvHost(store: Record<string, string | undefined>) {
  return {
    storage: {
      kv: {
        get: async <T>(key: string) => (store[key] as T | undefined) ?? null,
      },
    },
  };
}

describe("ownerLocale", () => {
  it("uses an explicit ru or en preference", async () => {
    expect(await ownerLocale(kvHost({ "preferences:locale": "en" }))).toBe("en");
    expect(await ownerLocale(kvHost({ "preferences:locale": "ru" }))).toBe("ru");
  });

  it("falls back to the last UI-resolved locale when preference is auto or unset", async () => {
    expect(await ownerLocale(kvHost({ "preferences:locale": "auto", [OWNER_RESOLVED_LOCALE_KEY]: "en" }))).toBe("en");
    expect(await ownerLocale(kvHost({ [OWNER_RESOLVED_LOCALE_KEY]: "ru" }))).toBe("ru");
  });

  it("defaults to ru when nothing is stored", async () => {
    expect(await ownerLocale(kvHost({}))).toBe("ru");
  });

  it("ignores a resolved locale when the preference is explicit", async () => {
    expect(await ownerLocale(kvHost({ "preferences:locale": "ru", [OWNER_RESOLVED_LOCALE_KEY]: "en" }))).toBe("ru");
  });
});

describe("owner form copy", () => {
  it("builds the council form in ru and en", () => {
    expect(councilOwnerForm("ru", "How to raise repeat purchases?")).toEqual({
      question: "Совет «How to raise repeat purchases?» ждёт вас. Добавьте свой довод или позвольте председателю решить.",
      decideLabel: "Пусть решит председатель",
    });
    expect(councilOwnerForm("en", "How to raise repeat purchases?")).toEqual({
      question: "The council «How to raise repeat purchases?» waits for you. Add a point, or let the chair decide.",
      decideLabel: "Let the chair decide",
    });
  });

  it("builds the self-repair form in ru and en", () => {
    expect(selfRepairOwnerForm("ru", "index.lock")).toEqual({
      question: "Самоисправление «index.lock» ждёт вашего решения. Откройте тред ремонта, чтобы прочитать отчёт.",
      options: ["Делать, как предлагает отчёт", "Оставить как есть"],
    });
    expect(selfRepairOwnerForm("en", "index.lock")).toEqual({
      question: "Self-repair of «index.lock» needs your decision. Open the repair thread for its report.",
      options: [SELF_REPAIR_GO_AHEAD_EN, SELF_REPAIR_LEAVE_EN],
    });
    expect(englishSelfRepairChoice("1")).toBe(SELF_REPAIR_GO_AHEAD_EN);
    expect(englishSelfRepairChoice("2")).toBe(SELF_REPAIR_LEAVE_EN);
  });

  it("localizes the workflow human-step wrapper", () => {
    expect(workflowHumanDetail("en", "wfrun_1", "approve")).toBe("Workflow run wfrun_1, step approve.");
    expect(workflowHumanDetail("ru", "wfrun_1", "approve")).toBe("Запуск графа wfrun_1, шаг approve.");
  });
});

describe("preferences remember the resolved locale", () => {
  it("stores the UI-resolved locale on get and set", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    await plugin(bb);
    await harness.behavior.callRpc("get_preferences", { suggestedLocale: "en" });
    expect(await bb.storage.kv.get(OWNER_RESOLVED_LOCALE_KEY)).toBe("en");
    await harness.behavior.callRpc("set_locale", { locale: "auto", suggestedLocale: "ru" });
    expect(await bb.storage.kv.get(OWNER_RESOLVED_LOCALE_KEY)).toBe("ru");
    expect(await ownerLocale(bb)).toBe("ru");
    await harness.behavior.callRpc("set_locale", { locale: "en", suggestedLocale: "ru" });
    expect(await ownerLocale(bb)).toBe("en");
  });
});

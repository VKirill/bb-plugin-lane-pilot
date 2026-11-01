import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createJev, setJevForTests, type JevClient } from "@lane-pilot/jev";
import { ROLE_IDS } from "@lane-pilot/models";
import { openDatabase } from "../../src/rooms/storage/database";
import { ERRAND_KINDS, errandKindRole, hintedErrandKind } from "../../src/rooms/schedule/errand-kinds";
import { ERRAND_KIND_ID, classifyErrand, errandKindJudgment } from "../../src/rooms/schedule/errand-kind-judgment";

const SURE = { devops: 0.8, computer: 0.1, browser: 0.05, research: 0.03, message: 0.02 };
const ACTIVE = { settings: { "jev.modes": "errand.kind=active" } };
const CRM = "Open the CRM and report the number of new leads.";

function jevAnswering(probabilities: Record<string, number>) {
  const top = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0];
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const client: JevClient = {
    breaker: () => ({ open: false, failures: 0 }),
    async call(request) {
      return { ok: true, model: "jev-test", usage: { input_tokens: 500, output_tokens: 20 }, latencyMs: 50, attempts: 1,
        answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: "choice" as const, choice: top, probabilities, confidence: probabilities[top]! }])) };
    },
  };
  const jev = createJev({ client, db });
  setJevForTests(jev);
  return { db, jev };
}
const receipts = (db: ReturnType<typeof openDatabase>) => db.prepare("SELECT judgment, mode FROM lane_pilot_jev_receipt").all() as Array<{ judgment: string; mode: string }>;
afterEach(() => setJevForTests(null));

describe("errand kinds: the row of the role table each runs on", () => {
  it("every kind but message has a row of its own; message, no kind and an unknown word run on the errand row", () => {
    expect(errandKindRole("computer")).toBe("errand-computer");
    expect(errandKindRole("devops")).toBe("errand-devops");
    expect(errandKindRole("research")).toBe("errand-research");
    expect(errandKindRole("browser")).toBe("errand-browser");
    for (const kind of ERRAND_KINDS) expect(ROLE_IDS).toContain(errandKindRole(kind));
    for (const none of ["message", undefined, null, "", "cooking"]) expect(errandKindRole(none)).toBe("errand");
  });

  it("hints: a named skill, plugin or MCP server first (an explicit ask), then the words of the brief; nothing is null", () => {
    expect(hintedErrandKind({ task: "Проверь кабинет и нажми кнопку", skills: ["computer-use"] })).toBe("computer");
    expect(hintedErrandKind({ task: "Собери модель багета", mcp: ["blender"] })).toBe("devops");
    expect(hintedErrandKind({ task: "Проверь, что сохраняется", plugins: ["browser-automation"] })).toBe("browser");
    expect(hintedErrandKind({ task: "Ответь в тикет VP814113214 клиенту" })).toBe("message");
    expect(hintedErrandKind({ task: "Запиши экран iShot Pro на MacBook и опиши окна" })).toBe("computer");
    expect(hintedErrandKind({ task: "Install the MagicSEO plugin on the BB hub over ssh" })).toBe("devops");
    expect(hintedErrandKind({ task: "Войди в кабинет MagicSEO и проверь экран старта" })).toBe("browser");
    expect(hintedErrandKind({ task: "Составь карту функционала приложения iShot" })).toBe("research");
    expect(hintedErrandKind({ task: CRM })).toBeNull();
  });
});

describe("errand.kind (J-12): Jev names the kind where no hint did", () => {
  it("is registered in shadow with a 0.6 threshold and the generic row as its fallback", () => {
    expect(errandKindJudgment).toMatchObject({ id: ERRAND_KIND_ID, version: 1, defaultMode: "shadow" });
    expect(errandKindJudgment.thresholds.min_p!.default).toBe(0.6);
    expect(errandKindJudgment.fallback({ task: CRM })).toBe("errand");
  });

  it("shadow (the default): the generic row decides and the receipt keeps what Jev would have picked", async () => {
    const { db } = jevAnswering(SURE);
    expect(await classifyErrand({ task: CRM }, { settings: {} })).toEqual({ kind: "errand", by: "none" });
    expect(receipts(db)).toEqual([{ judgment: ERRAND_KIND_ID, mode: "shadow" }]);
  });

  it("active: Jev names the kind when it is sure, the generic row when its top option is under the threshold", async () => {
    jevAnswering(SURE);
    expect(await classifyErrand({ task: CRM }, ACTIVE)).toEqual({ kind: "devops", by: "jev" });
    jevAnswering({ devops: 0.5, computer: 0.5 });
    expect(await classifyErrand({ task: CRM }, ACTIVE)).toEqual({ kind: "errand", by: "none" });
    jevAnswering({ errand: 0.9, devops: 0.1 });
    expect(await classifyErrand({ task: CRM }, ACTIVE)).toEqual({ kind: "errand", by: "none" });
  });

  it("the PM's word asks nothing; a hint wins over an active Jev, which is still asked for the receipt", async () => {
    const { db } = jevAnswering(SURE);
    expect(await classifyErrand({ task: CRM, kind: "research" }, ACTIVE)).toEqual({ kind: "research", by: "pm" });
    expect(receipts(db)).toEqual([]);
    expect(await classifyErrand({ task: "Ответь в тикет клиенту" }, ACTIVE)).toEqual({ kind: "message", by: "hint" });
    expect(receipts(db)).toEqual([{ judgment: ERRAND_KIND_ID, mode: "active" }]);
  });

  it("no Jev installed: the hints or the generic row, no receipt", async () => {
    setJevForTests(null);
    expect(await classifyErrand({ task: CRM })).toEqual({ kind: "errand", by: "none" });
    expect(await classifyErrand({ task: CRM, skills: ["tavily"] })).toEqual({ kind: "research", by: "hint" });
  });
});

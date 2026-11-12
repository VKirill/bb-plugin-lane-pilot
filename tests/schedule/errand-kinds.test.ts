import { describe, expect, it } from "vitest";
import { ROLE_IDS } from "@lane-pilot/models";
import { ERRAND_KINDS, classifyErrand, errandKindRole, hintedErrandKind } from "../../src/rooms/schedule/errand-kinds";

const CRM = "Open the CRM and report the number of new leads.";

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

describe("errand kind: the PM's word, else a hint, else the generic row (no model)", () => {
  it("the PM's word wins over a hint; a hint names the kind; nothing is the generic row", () => {
    expect(classifyErrand({ task: CRM, kind: "research" })).toEqual({ kind: "research", by: "pm" });
    expect(classifyErrand({ task: "Ответь в тикет клиенту", kind: "cooking" })).toEqual({ kind: "message", by: "hint" });
    expect(classifyErrand({ task: CRM })).toEqual({ kind: "errand", by: "none" });
    expect(classifyErrand({ task: CRM, skills: ["tavily"] })).toEqual({ kind: "research", by: "hint" });
  });
});

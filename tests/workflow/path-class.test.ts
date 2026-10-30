import { describe, expect, it } from "vitest";
import { pathClassByRules, pathClassFrom } from "@lane-pilot/workflow-engine";
import { pathClassJudgment } from "../../src/rooms/phase/intake";

const answer = (field: string, top: string, p: number) => ({ [field]: { type: "choice" as const, probabilities: { [top]: p } } });

describe("path class of an owner's request", () => {
  it("reads a short concrete tweak as tiny and low without a model", () => {
    expect(pathClassByRules("покрась кнопку в синий")).toEqual({ size: "tiny", risk: "low", confident: true });
    expect(pathClassByRules("Typo in the Send button label")).toEqual({ size: "tiny", risk: "low", confident: true });
  });

  it("reads auth, payments and migrations as high risk, and a redesign as large", () => {
    expect(pathClassByRules("Fix the password reset check")).toMatchObject({ risk: "high", confident: true });
    expect(pathClassByRules("Перепиши архитектуру авторизации и платежей")).toEqual({ size: "large", risk: "high", confident: true });
    expect(pathClassByRules("x".repeat(701))).toMatchObject({ size: "large", confident: true });
  });

  it("leaves an ambiguous short line to the judgment", () => {
    expect(pathClassByRules("сделай получше")).toMatchObject({ size: "small", confident: false });
  });

  it("keeps a given size and risk, and a critical severity raises the risk", () => {
    expect(pathClassFrom("покрась кнопку", { size: "small", risk: "medium" })).toMatchObject({ size: "small", risk: "medium", by: "input" });
    expect(pathClassFrom("покрась кнопку", { severity: "critical" })).toMatchObject({ risk: "high", severity: "critical" });
  });

  it("takes Jev's pick when it is sure, and the rules when it is not", () => {
    const sure = pathClassJudgment.decide(
      { ...answer("size", "large", 0.8), ...answer("risk", "high", 0.8) } as never,
      { min_p: 0.55 },
      { text: "покрась кнопку в синий" },
    );
    expect(sure.decision).toEqual({ size: "large", risk: "high" });
    const unsure = pathClassJudgment.decide(
      { ...answer("size", "large", 0.4), ...answer("risk", "high", 0.4) } as never,
      { min_p: 0.55 },
      { text: "покрась кнопку в синий" },
    );
    expect(unsure.decision).toEqual({ size: "tiny", risk: "low" });
  });
});

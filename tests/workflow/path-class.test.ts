import { describe, expect, it } from "vitest";
import { pathClassByRules, pathClassFrom } from "@lane-pilot/workflow-engine";

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

  it("reads an ambiguous short line as small, not confident", () => {
    expect(pathClassByRules("сделай получше")).toMatchObject({ size: "small", confident: false });
  });

  it("keeps a given size and risk, and a critical severity raises the risk", () => {
    expect(pathClassFrom("покрась кнопку", { size: "small", risk: "medium" })).toMatchObject({ size: "small", risk: "medium", by: "input" });
    expect(pathClassFrom("покрась кнопку", { severity: "critical" })).toMatchObject({ risk: "high", severity: "critical" });
  });
});

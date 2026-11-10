import { describe, expect, it } from "vitest";
import { laneSessionOverlayPrompt } from "../../src/rooms/native-agent/native-agent-overlay";

describe("ported specialist sessions", () => {
  it("[sma:k_ag_selector] the selector recommends one option and does not build the feature", () => {
    const text = laneSessionOverlayPrompt("framework-selector");
    // One recommendation, now with the scored matrix that leads to it.
    expect(text).toContain("Recommend the option with the highest weighted total and say why");
    expect(text).toContain("Do not build the feature");
  });


  it("[sma:k_ag_advisor] one gray area gets two or three options and a recommendation", () => {
    const text = laneSessionOverlayPrompt("advisor-researcher");
    expect(text).toContain("two or three options");
    expect(text).toContain("your recommendation");
  });
});

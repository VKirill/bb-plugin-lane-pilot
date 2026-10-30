import { describe, expect, it } from "vitest";
import { pickCriticByAccuracy } from "../../src/rooms/critique/critic-pair";

const current = { providerId: "codex", model: "gpt-a" };
const better = { providerId: "claude", model: "opus-b" };

const row = (model: string, labeled: number, accuracy: number) => ({ model, labeled, accuracy });

describe("critic pair by accuracy", () => {
  it("promotes the best accuracy, demotes a model under the floor, and holds a lead inside the hysteresis", () => {
    expect(pickCriticByAccuracy(current, [better], [row("gpt-a", 8, 40), row("opus-b", 8, 80)])).toEqual({ pair: better, changed: true });
    expect(pickCriticByAccuracy(current, [better], [row("gpt-a", 8, 80), row("opus-b", 8, 88)])).toEqual({ pair: current, changed: false });
    expect(pickCriticByAccuracy(current, [better], [row("gpt-a", 8, 70), row("opus-b", 8, 80)])).toEqual({ pair: better, changed: true });
    expect(pickCriticByAccuracy(current, [better], [row("gpt-a", 8, 40), row("opus-b", 7, 99)])).toEqual({ pair: current, changed: false });
    expect(pickCriticByAccuracy(current, [better], [row("gpt-a", 3, 10), row("opus-b", 8, 90)])).toEqual({ pair: current, changed: false });
  });
});
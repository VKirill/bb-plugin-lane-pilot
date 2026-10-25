import { describe, expect, it } from "vitest";
import { WRITER_PROFILES, writerCandidates } from "@lane-pilot/models";
import { pickedWriterOverlay, writerModelJudgment } from "../src/rooms/writer/writer-model-pick";

const settings = {
  "writer.provider": "acp-cursor", "writer.model": "composer-2.5", "writer.reasoning_effort": "medium",
  "writer.fallback1.provider": "opencode2", "writer.fallback1.model": "router9/ag/gemini-3.8-flash-low", "writer.fallback1.reasoning_effort": "medium",
  "writer.fallback2.provider": "claude-code", "writer.fallback2.model": "claude-haiku-5-5", "writer.fallback2.reasoning_effort": "medium",
};
const profile = (key: string) => WRITER_PROFILES.find((row) => row.key === key)!;
const task = { title: "Fix the jump button", objective: "the jump button sits under the thumb", kind: "fix", area: "ui", risk: "low", owns_paths: ["src/Hud.luau"], expected_outputs: ["src/Hud.luau"], acceptance: ["lune run tests passes"] };

describe("the writers' anamnesis", () => {
  it("offers only the models the subscriptions have: no Haiku as a writer, no Gemini Pro, Argon or MiniMax", () => {
    const keys = writerCandidates({}).map((row) => row.key);
    expect(keys).toEqual(expect.arrayContaining(["composer", "gemini-flash", "gpt-sol", "gpt-luna", "sonnet", "opus", "glm-flash"]));
    expect(keys).not.toEqual(expect.arrayContaining(["haiku"]));
    for (const off of ["haiku", "gemini-pro", "gemini-argon", "minimax-flash"]) expect(keys).not.toContain(off);
    expect(writerCandidates({ "writer.models": ["composer", "gemini-flash"] }).map((row) => row.key)).toEqual(["composer", "gemini-flash"]);
    for (const row of WRITER_PROFILES.filter((item) => item.available)) expect(row.sources.length).toBeGreaterThan(0);
  });
});

describe("the writer pick", () => {
  it("asks Jev to choose among the candidates by their anamnesis, and keeps the project's writer when unsure", () => {
    const candidates = writerCandidates({});
    const questions = writerModelJudgment.questions({ task, candidates }) as Record<string, { options?: Record<string, string> } & Record<string, unknown>>;
    expect(JSON.stringify(questions)).toContain("Composer 2.5");
    const decide = (top: string, p: number) => writerModelJudgment.decide({ writer: { type: "choice", probabilities: { [top]: p, composer: 1 - p } } } as never, { min_p: 0.45 }, { task, candidates });
    expect(decide("gemini-flash", 0.7).decision).toEqual({ key: "gemini-flash" });
    const unsure = writerModelJudgment.decide({ writer: { type: "choice", probabilities: { "gemini-flash": 0.35, composer: 0.33, sonnet: 0.32 } } } as never, { min_p: 0.45 }, { task, candidates });
    expect(unsure.decision).toEqual({ key: null });
  });
  it("puts the picked model first and the project's writer and fallbacks behind it", () => {
    const overlay = pickedWriterOverlay(settings, profile("gpt-sol"))!;
    expect(overlay).toMatchObject({ "writer.provider": "codex", "writer.model": "gpt-6.1-sol", "writer.picked": "gpt-sol",
      "writer.fallback1.model": "composer-2.5", "writer.fallback2.model": "router9/ag/gemini-3.8-flash-low", "writer.fallback3.model": "claude-haiku-5-5" });
    // A pick that is in the chain already is not repeated behind itself; the project's own writer changes nothing.
    expect(pickedWriterOverlay(settings, { ...profile("gemini-flash"), model: "router9/ag/gemini-3.8-flash-low" })).toMatchObject({ "writer.fallback1.model": "composer-2.5", "writer.fallback2.model": "claude-haiku-5-5", "writer.fallback3.provider": "" });
    expect(pickedWriterOverlay(settings, profile("composer"))).toBeNull();
  });
});

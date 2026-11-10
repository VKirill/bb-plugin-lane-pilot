import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { drawingFeedbackNote, drawingFeedbackProblems, type DrawingCritique } from "../../packages/contracts/src";
import { DESIGN_CRITIQUE_CASES_KEY, appendDesignCritiqueCase, critiqueProblems } from "../../src/rooms/design-eval";
import { credentialIssue, forgetSecrets, maskCredentials, registerSecrets, withoutCredentials } from "../../packages/kit/src/redact";
import { memoryContentIssue } from "../../packages/memory-core/src/candidates";
import { scrubQuote, unsafeReason } from "../../src/rooms/anamnesis/model";
const kv = () => { const store = new Map<string, unknown>(); return { get: async (k: string) => store.get(k) ?? null, set: async (k: string, v: never) => { store.set(k, v); }, store }; };

const critique = (over: Partial<DrawingCritique> = {}): DrawingCritique => ({
  scores: { hierarchy: 2, spacing: 2, contrast: 2, states: 1 },
  verdict: "rework", notes: "the hero needs more air", ...over,
});

describe("drawing critique and feedback forms", () => {
  it("[sma:m_sw_design_feedback] drawingFeedbackNote turns {goal, obstacle, question} into one note and refuses an empty field", () => {
    const note = drawingFeedbackNote({ goal: "a calm hero", obstacle: "the box is loud", question: "keep the box?" });
    expect(note).toBe("Цель: a calm hero Что мешает: the box is loud Вопрос: keep the box?");
    expect(() => drawingFeedbackNote({ goal: "  ", obstacle: "the box is loud", question: "keep the box?" })).toThrow(/goal/);
    expect(drawingFeedbackProblems({ goal: "okay", obstacle: "x".repeat(301), question: "fine" })).toEqual(["obstacle: 3 to 300 characters"]);
  });

  it("[sma:k_lib_dfeedback] a rework critique without obstacle fails critiqueProblems; one with all three and a set_case continuation passes and adds one case to lp.design.critique-cases", async () => {
    expect(critiqueProblems(critique({ goal: "a calm hero", question: "keep the box?" }))).toEqual(["a rework names the obstacle"]);
    const full = critique({ goal: "a calm hero", obstacle: "the box is loud", question: "keep the box?", continuation: { kind: "set_case", caseId: "hero-1" } });
    expect(critiqueProblems(full)).toEqual([]);
    expect(critiqueProblems(critique({ goal: "g", obstacle: "o", question: "q", continuation: { kind: "role_line", lesson: " " } }))).toEqual(["a role_line continuation names the lesson"]);
    const store = kv();
    await appendDesignCritiqueCase(store, { drawingSha: "sha1", form: full, expectedVerdict: "rework" });
    const cases = (await store.get(DESIGN_CRITIQUE_CASES_KEY)) as unknown[];
    expect(cases).toHaveLength(1);
    expect((cases[0] as { drawingSha: string }).drawingSha).toBe("sha1");
  });
});

describe("one credential mask for every outward writer", () => {
  it("[sma:k_lib_secretsmask] maskCredentials, scrubQuote, withoutCredentials and memoryContentIssue see the same secrets and none survives", () => {
    registerSecrets(["hunter2-known-secret"]);
    try {
      const text = `key sk-${"a".repeat(24)}; Bearer ${"b".repeat(20)}; пароль: abc12345; known hunter2-known-secret end`;
      for (const masked of [maskCredentials(text).text, scrubQuote(text), withoutCredentials(text)]) {
        expect(masked).not.toContain("a".repeat(24));
        expect(masked).not.toContain("b".repeat(20));
        expect(masked).not.toContain("abc12345");
        expect(masked).not.toContain("hunter2-known-secret");
      }
      expect(credentialIssue(text)).toBeTruthy();
      expect(memoryContentIssue(text)).toContain("credential");
      expect(unsafeReason(text)).toBe("an API key");
      expect(maskCredentials("nothing worth hiding").masked).toBe(false);
      expect(credentialIssue("nothing worth hiding")).toBeNull();
    } finally {
      forgetSecrets();
    }
  });
});

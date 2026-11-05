import { describe, expect, it } from "vitest";
import {
  WRITER_PROFILES, crossFamilyPeer, modelFamily, modelTier, roleModelKey, roleModelOption, roleModelProblem, writerCandidates,
} from "@lane-pilot/models";

describe("Gemini 4 Argon (Antigravity) in the role table", () => {
  it("is a strong Google-family option on acp-antigravity", () => {
    expect(roleModelOption("gemini-4-argon")).toMatchObject({
      providerId: "acp-antigravity", family: "google", tier: "strong", label: "Gemini 4 Argon (Antigravity)",
    });
    expect(modelFamily("gemini-4-argon")).toBe("google");
    expect(modelTier("gemini-4-argon")).toBe("strong");
    expect(crossFamilyPeer("gemini-4-argon")).toEqual({ providerId: "codex", model: "gpt-6.1-sol" });
  });

  it("is in the writers' anamnesis on acp-antigravity, not a writer candidate, with a note that it is in the Antigravity subscription and has no review-based profile yet", () => {
    const profile = WRITER_PROFILES.find((row) => row.key === "gemini-argon");
    expect(profile).toMatchObject({
      providerId: "acp-antigravity", model: "gemini-4-argon", available: false,
    });
    expect(profile!.note).toMatch(/Antigravity subscription/i);
    expect(profile!.note).toMatch(/no review-based/i);
    expect(writerCandidates({}).map((row) => row.key)).not.toContain("gemini-argon");
  });

  it("validates a stored pm-reader row that names gemini-4-argon", () => {
    expect(roleModelProblem(roleModelKey("pm-reader"), { model: "gemini-4-argon" })).toBeNull();
  });
});

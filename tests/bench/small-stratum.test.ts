import { describe, expect, it } from "vitest";
import { strataFor } from "../../src/rooms/bench/build";
import { DEFAULT_STRATA, isNoncodeCandidate, isSmallCandidate, smallPathSettings } from "../../src/rooms/bench/stratify";
import { callsBeforeWriter, renderStratumMetrics, stratumMetrics } from "../../src/rooms/bench/stratum-metrics";
import { judgeValidator } from "../../src/rooms/bench/validator";
import type { Candidate } from "../../src/rooms/bench/types";

const candidate = (contract: Record<string, unknown>, area = ""): Candidate => ({
  taskId: "t", runId: "r", projectId: "p", projectName: "P", attemptId: "a", attemptNo: 1, hard: false,
  risk: "low", area, repoPath: "/tmp/repo", hostId: "h", initialHeadSha: "abc", baseSha: null, contract,
});

describe("small and non-code strata", () => {
  it("keeps a button fix and drops a large rewrite", () => {
    expect(isSmallCandidate(candidate({ title: "покрась кнопку в синий", objective: "Синяя кнопка" }))).toBe(true);
    expect(isSmallCandidate(candidate({ title: "Перепиши архитектуру авторизации и платежей", objective: "Новая схема" }))).toBe(false);
    expect(isNoncodeCandidate(candidate({ title: "Заметка", kind: "docs" }))).toBe(true);
    expect(isNoncodeCandidate(candidate({ title: "Пост", kind: "feature" }, "social:threads"))).toBe(true);
    expect(isNoncodeCandidate(candidate({ title: "Кнопка", kind: "fix" }))).toBe(false);
  });

  it("adds small and noncode only when the build asks for them", () => {
    expect(strataFor({ now: 0 }).map((stratum) => stratum.key)).toEqual([...DEFAULT_STRATA.map((stratum) => stratum.key), "fresh"]);
    expect(strataFor({ only: ["small"], now: 0 }).map((stratum) => stratum.key)).toEqual(["small"]);
    expect(strataFor({ only: ["noncode"], now: 0 }).map((stratum) => stratum.key)).toEqual(["noncode"]);
  });

  it("reports time, calls before the writer and tokens, and the two paths", () => {
    expect(callsBeforeWriter([{ stageId: "plan" }, { stageId: "write" }])).toBe(1);
    const text = renderStratumMetrics(stratumMetrics([
      { taskId: "a", stratum: "small", accepted: true, seconds: 40, tokens: 100, stages: [{ stageId: "plan" }, { stageId: "write" }] },
      { taskId: "b", stratum: "small", accepted: true, seconds: 80, tokens: 300, stages: [{ stageId: "triage" }, { stageId: "plan" }, { stageId: "build" }] },
    ]), { "issue_quick.short_path": "off" });
    expect(text).toContain("small: 2 tasks, accepted 2, 60s to accept, 2 model calls before the writer, 400 tokens");
    expect(text).toContain("old issue-quick, 2 model calls before the writer");
    expect(smallPathSettings("short")).toEqual({});
    expect(smallPathSettings("legacy")).toEqual({ "issue_quick.short_path": "off" });
  });

  it("accepts a non-empty artifact and leaves a named validator for the employees branch", () => {
    expect(judgeValidator(null, "/tmp/out.md")).toEqual({ ok: true, reason: "artifact exists and is not empty" });
    expect(judgeValidator("artifact", "  ")).toMatchObject({ ok: false });
    expect(judgeValidator("errand", "/tmp/out.md").ok).toBe(false);
  });
});

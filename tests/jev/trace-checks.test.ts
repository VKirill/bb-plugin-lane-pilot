import { describe, expect, it } from "vitest";
import type { JevAnswer, JevCallResult, JevClient } from "@lane-pilot/jev";
import { createJev } from "@lane-pilot/jev";
import { traceChecks, TRACE_CHECKS, TRACE_CHECKS_ID } from "@lane-pilot/jev/judgments/trace-checks";
import { judgeTrace, jevalsLine } from "../../src/rooms/bench/jevals";
import type { ManifestTask } from "../../src/rooms/bench/types";
import type { AttemptMetrics } from "../../src/rooms/usage/server";

const task: ManifestTask = {
  taskId: "T1", position: 1, projectId: "p1", projectName: "demo", hostId: "h1", repoPath: "/r", stratum: "s", hard: false, risk: "low", area: "a",
  initialHeadSha: "a", solutionCommit: "b", solutionPatchSha256: "c",
  contract: { title: "Fix the button", objective: "make it blue", acceptance: ["vitest green"] }, warm: { base: [], solution: [], discriminating: [], applied: "apply", files: [] },
};
const attempt: AttemptMetrics = {
  taskId: "T1", attemptId: "att_1", attemptNo: 1, state: "accepted", createdAt: 0, seconds: 60,
  stages: [{ stageId: "verify", state: "passed", seconds: 10, proof: "checks" }], stagesPassed: 1, stagesFailed: 0,
  gates: { passed: 1, rejected: 0 }, writer: { threadId: "thr", providerId: "p", model: "m", tier: null }, tokens: null, costUsd: null, costState: "not_measured", costNote: null,
};

function scriptedClient(nouls: Record<string, number>, outcomes: string[]) {
  const receipts: number[] = [];
  const client: JevClient = {
    breaker: () => ({ open: false, failures: 0 }),
    async call(request): Promise<JevCallResult> {
      const answers: Record<string, JevAnswer> = {};
      for (const [id, q] of Object.entries(request.questions)) {
        const name = id.split("::").pop()!;
        answers[id] = { type: "noul", noul: nouls[name] ?? 0.9 };
      }
      return { ok: true, model: "m", usage: { input_tokens: 100, output_tokens: 10 }, latencyMs: 1, attempts: 1, answers };
    },
  };
  return { client };
}

describe("audit.trace judgment", () => {
  it("one request carries every check; p below flag_below comes back in flags", async () => {
    const { client } = scriptedClient({ indirect_injection: 0.1 }, []);
    const jev = createJev({ client });
    const verdict = await jev.judge(traceChecks, { task: { title: "Fix", objective: "", acceptance: [] }, trace: "did things" }, { settings: { "jev.modes": `${TRACE_CHECKS_ID}=active` } });
    expect(verdict.by).toBe("jev");
    if (verdict.by !== "jev") return;
    expect(Object.keys(verdict.decision.checks)).toEqual(TRACE_CHECKS);
    expect(verdict.decision.flags).toEqual(["indirect_injection"]);
  });

  it("an indirect_injection flag marks the receipt as a warning", async () => {
    const marked: Array<{ id: number | null; outcome: string }> = [];
    const { client } = scriptedClient({ indirect_injection: 0.05 }, []);
    const base = createJev({ client });
    const jev = { ...base, outcome: (id: number | null, outcome: string) => marked.push({ id, outcome }) };
    const result = await judgeTrace(
      { jev: () => jev as never, settings: { "jev.modes": `${TRACE_CHECKS_ID}=active` }, projectId: "p1" },
      { task, outcome: { latestState: "accepted" }, attempts: [attempt], reason: null },
    );
    expect(result?.flags).toContain("indirect_injection");
    expect(marked).toEqual([{ id: null, outcome: "warn:indirect_injection" }]);
  });

  it("a clean trace reports no flags; the report line reads clean", async () => {
    const { client } = scriptedClient({}, []);
    const jev = createJev({ client });
    const result = await judgeTrace(
      { jev: () => jev, settings: { "jev.modes": `${TRACE_CHECKS_ID}=active` }, projectId: "p1" },
      { task, outcome: { latestState: "accepted" }, attempts: [attempt], reason: null },
    );
    expect(result?.flags).toEqual([]);
    expect(jevalsLine(result)).toContain("clean");
    expect(jevalsLine(null)).toBeNull();
  });
});

describe("audit.trace per-check thresholds", () => {
  it("safety checks flag at their own bar: p(yes) 0.45 flags a leak, not a quality check", async () => {
    const t = { flag_below: 0.4, flag_safety: 0.5 };
    const at = (v: number) => Object.fromEntries(TRACE_CHECKS.map((name) => [name, { type: "noul" as const, noul: v }])) as never;
    // All checks at 0.45: only the safety pair flags.
    const mid = at(0.45); (mid as any).no_secret_leak.noul = 0.45;
    expect(traceChecks.decide(mid, t, { task: { title: "" }, trace: "" }).decision!.flags).toEqual(["no_secret_leak", "indirect_injection"]);
    // Quality checks under flag_below flag as before.
    const low = at(0.9); (low as any).plan_followed.noul = 0.3;
    expect(traceChecks.decide(low, t, { task: { title: "" }, trace: "" }).decision!.flags).toEqual(["plan_followed"]);
  });
});

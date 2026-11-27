import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/rooms/plugin-db";
import {
  calibrateJudge,
  judgeTrusted,
  runPairwiseJudge,
  type PairwiseJudgeContext,
  type JudgeCalibrationContext,
} from "../../src/rooms/critique/server";
import type { HelperRunOptions, JudgeRunResult } from "../../src/rooms/critique/server";

function createTestCtx(outputs: string[]) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const logs: { info: string[]; warn: string[]; debug: string[] } = { info: [], warn: [], debug: [] };
  (bb as unknown as { log: unknown }).log = {
    info: (msg: string) => logs.info.push(msg),
    warn: (msg: string) => logs.warn.push(msg),
    error: () => {},
    debug: (msg: string) => logs.debug.push(msg),
  };

  const prompts: string[] = [];
  let callIndex = 0;

  const stubRunJudge = async <TResult>(
    options: HelperRunOptions<TResult> & {
      toVerdict: (results: TResult[], raws: string[]) => "pass" | "rework" | "block" | "not_run";
    },
  ): Promise<JudgeRunResult<TResult>> => {
    const step = options.stepsForRound({
      pair: options.pairs[0]!,
      round: 0,
      helperPolicy: { mode: "inherit", policy: null } as never,
    })[0]!;
    prompts.push(step.prompt);
    const raw = outputs[callIndex] ?? "";
    callIndex += 1;

    if (raw === "__EXHAUSTED__") {
      return {
        status: "exhausted",
        lastError: "judge_pool_exhausted",
        lastPair: options.pairs[0]!,
        pairs: options.pairs,
        verdict: "not_run",
        ms: 1,
      };
    }

    const parsed = step.parse ? await step.parse("thr_stub", raw) : (raw as TResult);
    const results = [parsed];
    const raws = [raw];
    const verdict = options.toVerdict(results, raws);
    return {
      status: "ok",
      pair: options.pairs[0]!,
      round: 0,
      threadIds: [`thr_${callIndex}`],
      raws,
      results,
      placement: {} as never,
      helperPolicy: { mode: "inherit", policy: null } as never,
      verdict,
      ms: 1,
    };
  };

  return {
    ctx: { bb, db, runJudge: stubRunJudge } as PairwiseJudgeContext & JudgeCalibrationContext,
    db,
    logs,
    prompts,
    dispose: () => harness.lifecycle.dispose(),
  };
}

describe("runPairwiseJudge", () => {
  it("returns candidate_better when both orders agree (ref_first=B, cand_first=A) and preserves dual order prompts", async () => {
    const { ctx, logs, prompts, dispose } = createTestCtx([
      '{"better":"B","reason":"clearer summary"}',
      '{"better":"A","reason":"more complete"}',
    ]);
    try {
      const res = await runPairwiseJudge(ctx, {
        workflowId: "wf_eval",
        reference: "SECRET_REF_OUTPUT",
        candidate: "SECRET_CAND_OUTPUT",
        task: "Summarize the invoice",
        rubric: ["Must cite total", "Must be concise"],
        judge: { provider: "codex", model: "gpt-6.1-sol" },
        candidateModel: "claude-sonnet-5-5",
      });
      expect(res).toEqual({
        outcome: "candidate_better",
        orders: ["candidate_better", "candidate_better"],
        judgeModel: "gpt-6.1-sol",
      });
      expect(prompts).toHaveLength(2);
      expect(prompts[0]).toContain('Two outputs for the same task. Answer with JSON {"better": "A"|"B"|"tie", "reason": string}');
      expect(prompts[0]!.indexOf("SECRET_REF_OUTPUT")).toBeLessThan(prompts[0]!.indexOf("SECRET_CAND_OUTPUT"));
      expect(prompts[1]!.indexOf("SECRET_CAND_OUTPUT")).toBeLessThan(prompts[1]!.indexOf("SECRET_REF_OUTPUT"));
      expect(logs.info.some((line) => line.includes("judge pairwise wf=wf_eval outcome=candidate_better orders=candidate_better/candidate_better model=gpt-6.1-sol"))).toBe(true);
      expect([...logs.info, ...logs.warn].join("\n")).not.toContain("SECRET_REF_OUTPUT");
      expect([...logs.info, ...logs.warn].join("\n")).not.toContain("SECRET_CAND_OUTPUT");
    } finally {
      await dispose();
    }
  });

  it("returns reference_better when both orders agree on reference", async () => {
    const { ctx, dispose } = createTestCtx([
      '{"better":"A","reason":"ref better"}',
      '{"better":"B","reason":"ref still better"}',
    ]);
    try {
      const res = await runPairwiseJudge(ctx, {
        workflowId: "wf_eval",
        reference: "ref",
        candidate: "cand",
        task: "task",
        judge: { provider: "opencode2", model: "router9/ag/gemini-3.8-flash-high" },
        candidateModel: "claude-opus-5-5",
      });
      expect(res.outcome).toBe("reference_better");
      expect(res.orders).toEqual(["reference_better", "reference_better"]);
    } finally {
      await dispose();
    }
  });

  it("returns tie when the two orders disagree (position bias)", async () => {
    const { ctx, logs, dispose } = createTestCtx([
      '{"better":"A","reason":"A looks first"}',
      '{"better":"A","reason":"A looks first again"}',
    ]);
    try {
      const res = await runPairwiseJudge(ctx, {
        workflowId: "wf_bias",
        reference: "ref",
        candidate: "cand",
        task: "task",
        judge: { provider: "codex", model: "gpt-6.1-sol" },
        candidateModel: "claude-opus-5-5",
      });
      expect(res.outcome).toBe("tie");
      expect(res.orders).toEqual(["reference_better", "candidate_better"]);
      expect(logs.info.some((line) => line.includes("outcome=tie orders=reference_better/candidate_better"))).toBe(true);
    } finally {
      await dispose();
    }
  });

  it("refuses same_family when judge and candidateModel share a ModelFamily without calling runJudge", async () => {
    const { ctx, prompts, logs, dispose } = createTestCtx([]);
    try {
      const res = await runPairwiseJudge(ctx, {
        workflowId: "wf_same",
        reference: "ref-secret",
        candidate: "cand-secret",
        task: "task",
        judge: { provider: "claude-code", model: "claude-opus-5-5" },
        candidateModel: "claude-sonnet-5-5",
      });
      expect(res.outcome).toBe("not_run");
      expect(res.orders).toEqual(["not_run", "not_run"]);
      expect(res.reason).toBe("same_family");
      expect(prompts).toHaveLength(0);
      expect(logs.warn.some((line) => line.includes("same_family"))).toBe(true);
    } finally {
      await dispose();
    }
  });

  it("returns not_run when an order output is unparsable or exhausted and never treats not_run as a pass", async () => {
    const { ctx, logs, dispose } = createTestCtx([
      '{"better":"B","reason":"good"}',
      "not json at all",
    ]);
    try {
      const res = await runPairwiseJudge(ctx, {
        workflowId: "wf_bad",
        reference: "SECRET_REF",
        candidate: "SECRET_CAND",
        task: "task",
        judge: { provider: "codex", model: "gpt-6.1-sol" },
        candidateModel: "claude-sonnet-5-5",
      });
      expect(res.outcome).toBe("not_run");
      expect(res.orders).toEqual(["candidate_better", "not_run"]);
      expect(logs.warn.some((line) => line.includes("outcome=not_run"))).toBe(true);
      expect([...logs.info, ...logs.warn].join("\n")).not.toContain("SECRET_REF");
      expect([...logs.info, ...logs.warn].join("\n")).not.toContain("SECRET_CAND");
    } finally {
      await dispose();
    }
  });

  it("returns not_run when runJudge returns exhausted", async () => {
    const { ctx, dispose } = createTestCtx(["__EXHAUSTED__", '{"better":"A","reason":"ok"}']);
    try {
      const res = await runPairwiseJudge(ctx, {
        workflowId: "wf_exhaust",
        reference: "ref",
        candidate: "cand",
        task: "task",
        judge: { provider: "codex", model: "gpt-6.1-sol" },
        candidateModel: "claude-sonnet-5-5",
      });
      expect(res.outcome).toBe("not_run");
      expect(res.orders).toEqual(["not_run", "candidate_better"]);
    } finally {
      await dispose();
    }
  });
});

describe("calibrateJudge and judgeTrusted", () => {
  it("marks 9/10 agreement (wilson_low ≈ 0.596) as not trusted", async () => {
    const outputs = [
      ...Array.from({ length: 9 }, () => '{"verdict":"accept","reason":"ok"}'),
      '{"verdict":"reject","reason":"disagree"}',
    ];
    const { ctx, db, logs, dispose } = createTestCtx(outputs);
    try {
      const cases = Array.from({ length: 10 }, (_, i) => ({
        caseId: `c${i}`,
        output: `SECRET_CASE_OUTPUT_${i}`,
        verdict: "accept" as const,
      }));
      const judge = { provider: "codex", model: "gpt-6.1-sol" };
      expect(judgeTrusted(db, "wf_cal", judge)).toBe(false);

      const res = await calibrateJudge(ctx, { workflowId: "wf_cal", judge, cases, now: 1700000000000 });
      expect(res.n).toBe(10);
      expect(res.agree).toBe(9);
      expect(res.wilsonLow).toBeCloseTo(0.596, 2);
      expect(res.trusted).toBe(false);
      expect(judgeTrusted(db, "wf_cal", judge)).toBe(false);
      expect(logs.info.some((line) => line.includes("judge calibration wf=wf_cal n=10 agree=9 low=0.596 trusted=false"))).toBe(true);
      expect([...logs.info, ...logs.warn].join("\n")).not.toContain("SECRET_CASE_OUTPUT");
    } finally {
      await dispose();
    }
  });

  it("marks 20/20 agreement as trusted and persists in lane_pilot_judge_calibration", async () => {
    const outputs = Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0 ? '{"verdict":"accept","reason":"good"}' : '{"verdict":"reject","reason":"bad"}',
    );
    const { ctx, db, logs, dispose } = createTestCtx(outputs);
    try {
      const cases = [
        ...Array.from({ length: 20 }, (_, i) => ({
          caseId: `c${i}`,
          output: `output-${i}`,
          verdict: (i % 2 === 0 ? "accept" : "reject") as "accept" | "reject",
        })),
        // Cases without a recorded output are ignored.
        { caseId: "missing", output: "", verdict: "accept" as const },
      ];
      const judge = { provider: "opencode2", model: "router9/ag/gemini-3.8-flash-high" };
      const res = await calibrateJudge(ctx, { workflowId: "wf_cal2", judge, cases, now: 1700000001000 });
      expect(res.n).toBe(20);
      expect(res.agree).toBe(20);
      expect(res.wilsonLow).toBeGreaterThan(0.7);
      expect(res.trusted).toBe(true);
      expect(judgeTrusted(db, "wf_cal2", judge)).toBe(true);
      expect(logs.info.some((line) => line.includes("judge calibration wf=wf_cal2 n=20 agree=20") && line.includes("trusted=true"))).toBe(true);
    } finally {
      await dispose();
    }
  });

  it("never turns unparsable/not_run judge answers into agreement during calibration", async () => {
    const outputs = [
      ...Array.from({ length: 9 }, () => '{"verdict":"accept","reason":"ok"}'),
      "garbled non-json output",
    ];
    const { ctx, db, logs, dispose } = createTestCtx(outputs);
    try {
      const cases = Array.from({ length: 10 }, (_, i) => ({
        caseId: `c${i}`,
        output: `SECRET_TXT_${i}`,
        verdict: "accept" as const,
      }));
      const judge = { provider: "codex", model: "gpt-6.1-sol" };
      const res = await calibrateJudge(ctx, { workflowId: "wf_cal3", judge, cases });
      expect(res.n).toBe(10);
      expect(res.agree).toBe(9);
      expect(res.trusted).toBe(false);
      expect(judgeTrusted(db, "wf_cal3", judge)).toBe(false);
      expect(logs.warn.some((line) => line.includes("outcome=not_run"))).toBe(true);
      expect([...logs.info, ...logs.warn].join("\n")).not.toContain("SECRET_TXT");
    } finally {
      await dispose();
    }
  });
});

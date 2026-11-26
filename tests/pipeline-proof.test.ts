import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { STAGE_IDS, STAGE_PROOF, acceptanceProofGap, isAdvisoryProof, stageProofSchema } from "@lane-pilot/contracts";
import type { StageId } from "@lane-pilot/contracts";
import { builtinWorkflow } from "../src/rooms/workflow/builtin";
import { LP_TASK_PIPELINE, type PrototypeConfig, type TaskV2 } from "../src/rooms/contracts";
import { createAttempt, createRun, createTask, getAttempt, listGateEventsForTask, openDatabase, saveProjectSetting, transitionAttempt } from "../src/rooms/plugin-db";
import { createCore } from "../src/rooms/core/server/core";
import { finishWriterAttemptBody } from "../src/rooms/writer/server/services/finish-attempt-body";
import { runPostValidationGates } from "../src/rooms/writer/server/services/post-validation-gates";
import { mountVerificationAttemptFinished } from "../src/rooms/writer/server/services/verification";
import {
  candidateCitations,
  demoteUncited,
  inputCitations,
  parseCodeCritique,
  parseCritique,
  parsePmReadResult,
  parseSpecialistResult,
} from "../src/rooms/critique";

const ADVISORY: StageId[] = ["pm-read", "plan-critique", "specialist-review", "code-critique"];

describe("every stage declares what decides it", () => {
  it("has a valid proof for every stage id: a code predicate, or advisory with a reason", () => {
    for (const stage of STAGE_IDS) {
      const proof = STAGE_PROOF[stage];
      expect(proof, stage).toBeDefined();
      expect(stageProofSchema.safeParse(proof).success, stage).toBe(true);
      if (isAdvisoryProof(proof)) expect((proof as { reason: string }).reason.length, stage).toBeGreaterThan(8);
    }
    expect(Object.keys(STAGE_PROOF).sort()).toEqual([...STAGE_IDS].sort());
  });

  it("calls the model-opinion stages advisory, and only those", () => {
    expect(STAGE_IDS.filter((stage) => isAdvisoryProof(STAGE_PROOF[stage])).sort()).toEqual([...ADVISORY].sort());
  });

  it("is declared in workflows/lp-task-pipeline.json for every node, and the file agrees with the registry", () => {
    const workflow = builtinWorkflow(LP_TASK_PIPELINE)!;
    const text = JSON.parse(readFileSync(join(__dirname, "../workflows/lp-task-pipeline.json"), "utf8")) as { nodes: Array<Record<string, unknown>> };
    expect(text.nodes.length).toBe(workflow.nodes.length);
    for (const node of workflow.nodes) {
      if (node.type === "note") continue;
      if (node.type === "lp-task") {
        const declared = (node as { stage_proof?: Record<string, unknown>; stages: string[] }).stage_proof ?? {};
        expect(Object.keys(declared).sort(), node.id).toEqual([...(node as { stages: string[] }).stages].sort());
        for (const [stage, proof] of Object.entries(declared)) expect(proof, stage).toEqual(STAGE_PROOF[stage as StageId]);
        continue;
      }
      expect((node as { proof?: unknown }).proof, node.id).toBeDefined();
    }
    const proofOf = (id: string) => (workflow.nodes.find((node) => node.id === id) as { proof?: unknown }).proof;
    expect(proofOf("pm-read")).toEqual(STAGE_PROOF["pm-read"]);
    expect(proofOf("plan-critique")).toEqual(STAGE_PROOF["plan-critique"]);
    expect(proofOf("plan-critique-quick")).toEqual(STAGE_PROOF["plan-critique"]);
    expect(proofOf("specialist-review")).toEqual(STAGE_PROOF["specialist-review"]);
    expect(proofOf("ownership-base")).toEqual(STAGE_PROOF["run-gate"]);
  });
});

describe("a model's opinion alone never accepts a task", () => {
  it("refuses acceptance when only advisory stages passed, in every combination", () => {
    for (let mask = 1; mask < 1 << ADVISORY.length; mask++) {
      const passed = ADVISORY.filter((_, index) => mask & (1 << index));
      expect(acceptanceProofGap(passed), passed.join("+")).toMatch(/^acceptance_without_code_proof: only advisory stages passed/);
    }
    expect(acceptanceProofGap([])).toMatch(/^acceptance_without_code_proof/);
  });

  it("accepts as soon as one stage decided by code passed, with or without the opinions", () => {
    expect(acceptanceProofGap(["writer-agent"])).toBeNull();
    expect(acceptanceProofGap(["verification", "code-critique"])).toBeNull();
    expect(acceptanceProofGap(["pm-read", "plan-critique", "specialist-review", "code-critique", "acceptance-receipt"])).toBeNull();
  });

  it("is checked where acceptance is decided: before the acceptance receipt is written", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        threads: {
          get: async () => ({ status: "idle" }) as never,
          output: async () => ({ text: "done" }) as never,
          events: { list: async () => [] as never },
          stop: async () => ({}) as never,
        },
        environments: { list: async () => [{ id: "env-1" }] as never },
      },
    });
    const db = openDatabase(bb);
    const ctx = createCore(bb, db);
    const config: PrototypeConfig = {
      projectId: "P", hostId: "h", pmWorkspacePath: "/repo", writerWorkspacePath: "/repo",
      pmProviderId: "codex", pmModel: "codex-test", writerProviderId: "codex", writerModel: "codex-test",
    };
    const makeTask = (id: string, risk: TaskV2["risk"] = "low"): TaskV2 => ({
      schema_version: 2, id, title: `Task ${id}`, risk, lane: "writer", project_cwd: "/repo",
      read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: ["note.txt"],
      owns_paths: ["note.txt"], never_touch: [], depends_on: [], objective: "write", acceptance: ["done"],
      verify: "none", verification: [],
    });

    createRun(db, "run", "P", "cli", "/repo");
    saveProjectSetting(db, "P", "code_critique.enabled", false);
    saveProjectSetting(db, "P", "owner.words", "off");

    const t1 = makeTask("t1");
    createTask(db, { id: "t1", runId: "run", kind: "bb", contract: t1 });
    createAttempt(db, { id: "a1", runId: "run", taskId: "t1" });
    transitionAttempt(db, "a1", "spawn_requested");
    transitionAttempt(db, "a1", "running", { threadId: "w1" });

    const persistAcceptance = vi.fn(async () => ({ state: "passed" }));
    const services = {
      validateWriterResult: vi.fn(async () => ({ status: "accepted" as const, output: "done", produced: ["note.txt"], verification: [] })),
      persistWriterAcceptance: persistAcceptance,
      workspaceDirt: async () => ({ ok: true, snapshots: [] }),
      stageHelperSettings: async () => ({}),
      runBudgetFor: () => ({ snapshot: () => ({ limits: {} }) }),
    };

    const gated = await runPostValidationGates({
      ctx,
      services: services as never,
      input: { projectId: "P", config, task: t1, runId: "run", taskId: "t1", attemptId: "a1", pmThreadId: "pm", writerThreadId: "w1", dirtBefore: [] },
      candidate: { status: "needs_review" as never, output: "done", produced: ["note.txt"], verification: [] },
      writerThreadId: "w1",
      answer: "done",
      endedByStop: () => null,
      stoppedMeanwhile: () => null,
    });
    expect(gated).toMatchObject({ kind: "terminal", result: { status: "blocked", reason: expect.stringMatching(/^acceptance_without_code_proof/) } });
    expect(getAttempt(db, "a1")?.state).toBe("blocked");
    expect(listGateEventsForTask(db, "run", "t1")).toContainEqual(expect.objectContaining({ gate: "accept", status: "rejected" }));

    // finishWriterAttemptBody never reaches merge/persistWriterAcceptance when post-validation gates block.
    saveProjectSetting(db, "P", "critic.challenge_high", "on");
    const t2 = makeTask("t2", "high");
    createTask(db, { id: "t2", runId: "run", kind: "bb", contract: t2 });
    createAttempt(db, { id: "a2", runId: "run", taskId: "t2" });
    transitionAttempt(db, "a2", "spawn_requested");
    transitionAttempt(db, "a2", "running", { threadId: "w2" });

    const verification = mountVerificationAttemptFinished(ctx, services as never);
    const finished = await finishWriterAttemptBody(
      ctx,
      services as never,
      verification,
      { projectId: "P", config, task: t2, runId: "run", taskId: "t2", attemptId: "a2", pmThreadId: "pm", writerThreadId: "w2", dirtBefore: [] },
      { writerStopped: false },
    );
    expect(finished).toMatchObject({ status: "blocked", reason: expect.stringMatching(/^challenge_gate:/) });
    expect(persistAcceptance).not.toHaveBeenCalled();
    await harness.lifecycle.dispose();
  });
});

describe("the code check on a reviewer's opinion", () => {
  const finding = (file: string, line: number | null, severity = "high") => ({ file, line, severity, evidence: "the quoted line `const a = b`", finding: "wrong", criterion: "rule" });
  const verdict = (findings: unknown[]) => JSON.stringify({ status: "rework", summary: "s", findings, evidence: "read the plan" });

  it("plan critique: a serious finding on a file the critic was never shown counts as medium (the critic's own status is kept)", () => {
    const shown = inputCitations(JSON.stringify({ owns_paths: ["src/a.ts"] }), "edit src/a.ts");
    const kept = parseCritique(verdict([finding("src/a.ts", 3)]), shown);
    expect(kept.status).toBe("rework");
    expect(kept.demoted).toBeUndefined();
    const invented = parseCritique(verdict([finding("src/invented.ts", 3)]), shown);
    expect(invented.demoted).toBe(1);
    expect(invented.verdict.findings[0]!.severity).toBe("medium");
    expect(invented.findings[0]!.severity).toBe("warning");
    // Without a check nothing changes: the old callers keep the old reading.
    expect(parseCritique(verdict([finding("src/invented.ts", 3)])).status).toBe("rework");
  });

  it("plan critique and specialist review take TASK and PLAN as real files", () => {
    const shown = inputCitations("{}", "plan text");
    expect(parseCritique(verdict([finding("TASK", 1)]), shown).status).toBe("rework");
    const risk = JSON.stringify({ status: "block", summary: "s", findings: [finding("src/ghost.ts", 1, "critical")], evidence: "x" });
    const reviewed = parseSpecialistResult(risk, shown);
    expect(reviewed.demoted).toBe(1);
    expect(reviewed.risks).toEqual([]);
  });

  it("code critique: a line past the end of a file the critic was shown is not believed; a file it was not shown is not refuted", () => {
    const cites = candidateCitations([{ path: "src/a.ts", content: "one\ntwo\nthree" }, { path: "src/big.ts", content: "x".repeat(9000) }], 8 * 1024);
    expect(parseCodeCritique(verdict([finding("src/a.ts", 2)]), cites).status).toBe("rework");
    const past = parseCodeCritique(verdict([finding("src/a.ts", 40)]), cites);
    expect(past.demoted).toBe(1);
    expect(past.status).toBe("pass");
    expect(parseCodeCritique(verdict([finding("src/big.ts", 900)]), cites).status).toBe("rework");
    expect(parseCodeCritique(verdict([finding("src/caller.ts", 12)]), cites).status).toBe("rework");
  });

  it("demoteUncited leaves a verdict alone without a check", () => {
    const parsed = { status: "rework" as const, findings: [], evidence: "e" };
    expect(demoteUncited(parsed, undefined)).toEqual({ verdict: parsed, demoted: 0 });
  });

  it("pm-read: a blank summary is no read", () => {
    expect(parsePmReadResult(JSON.stringify({ summary: "The excerpts show X.", keyFacts: [], openQuestions: [] })).summary).toContain("X");
    expect(() => parsePmReadResult(JSON.stringify({ summary: "   \n ", keyFacts: [], openQuestions: [] }))).toThrow();
    expect(() => parsePmReadResult("no json here")).toThrow();
  });
});

import type { NodeExecutor, GraphNode, WorkflowEngine } from "@lane-pilot/workflow-engine";
import { agentRequest, withResolvedModel, type WorkflowAgents } from "./workflow-agent";
import type { ChainRuntime } from "./workflow-runtime";
import type { ServerCore } from "../../core/server";
import { jev, type JevSettings, type Verdict, choiceOf } from "@lane-pilot/jev";
import { failureClassJudgment, type FailureClassDecision, type FailureClassInput } from "../../runs/failure-class-judgment";
import { redactKnown } from "@lane-pilot/kit";

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * Strict whitelist state builder for each failure item.
 * Explicit field selection with no spread operator, clipped bounds, and secrets redacted.
 */
export function buildFailureInput(item: unknown): FailureClassInput {
  const f = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
  const state = typeof f.state === "string" ? f.state : "validation_failed";
  const rawReason = typeof f.reason === "string" ? f.reason
    : typeof f.message === "string" ? f.message
    : typeof f.error === "string" ? f.error
    : typeof f.symptom === "string" ? f.symptom
    : typeof f.id === "string" ? `test failed: ${f.id}`
    : "test failed";
  return {
    state: clip(state, 120),
    reason: clip(redactKnown(rawReason), 1_500),
  };
}

/**
 * Custom executor for `quality-loop.classify`:
 * Uses Jev's existing `failure.class` judgment in batch mode (`judgeMany`) to categorize failing checks
 * into code_defects and env_issues without spawning a full triager agent.
 *
 * In shadow mode (the default) or when Jev is uncertain on any failure (verdict.by === 'escalate'),
 * execution falls back to the full triager agent as before.
 */
export function registerQualityLoopClassifyExecutor(
  engine: WorkflowEngine,
  ctx: ServerCore,
  agents: WorkflowAgents,
): void {
  engine.register<ChainRuntime>("quality-loop.classify", {
    reentrant: true,
    run: async (c) => {
      const node = c.node as Extract<GraphNode, { type: "agent" }>;

      const runAgent = async () => {
        const resolved = await withResolvedModel(agentRequest(c, node));
        const result = await agents.run(resolved);
        return {
          output: result.output,
          threadId: result.threadId,
          ...(result.usage ? { usage: result.usage } : {}),
        };
      };

      const rawFailures = (c.input.with.failures ?? c.resolve("test_gen.failures") ?? c.inputs.failures ?? []) as unknown[];
      const failures = Array.isArray(rawFailures) ? rawFailures : [];

      if (!failures.length) {
        return {
          output: {
            failures: [],
            code_defects: [],
            test_defects: 0,
            env_issues: [],
            code_defect_count: 0,
          },
        };
      }

      const instance = jev();
      const project = c.runtime?.projectId;
      const settings = project
        ? ((await ctx.effectiveProjectSettings(project).catch(() => null))?.values as JevSettings)
        : undefined;

      if (!instance || !instance.enabled(settings)) {
        return await runAgent();
      }

      const failureInputs = failures.map(buildFailureInput);
      let verdicts: Array<Verdict<FailureClassDecision>> = [];

      try {
        verdicts = await instance.judgeMany(failureClassJudgment, failureInputs, {
          projectId: project ?? null,
          runId: c.runId,
          subject: `classify:${c.stepKey}`,
          settings,
          signal: c.signal,
        });
      } catch (cause) {
        ctx.log?.(
          `quality-loop classify: Jev judgeMany failed (${cause instanceof Error ? cause.message : String(cause)}), falling back to triager agent`,
        );
        return await runAgent();
      }

      // Check if all verdicts were decided confidently by Jev in active mode
      const isConfident = (v: Verdict<FailureClassDecision>): boolean => {
        if (v.by !== "jev") return false;
        const pick = choiceOf(v.answers, "side");
        return Boolean(pick && pick.p >= 0.7 && pick.margin >= 0.3);
      };
      const allConfident = verdicts.length === failureInputs.length && verdicts.every(isConfident);

      if (!allConfident) {
        // Shadow mode or uncertain failure: fall back to triager agent
        const agentResult = await runAgent();
        verdicts.forEach((v) => {
          if (v.receiptId && v.by === "fallback" && v.shadow?.decision) {
            instance.outcome(v.receiptId, `shadow:${v.shadow.decision.cls}`);
          }
        });
        return agentResult;
      }

      // Active mode: build output directly from Jev's batch decisions
      const jevVerdicts = verdicts as Array<Extract<Verdict<FailureClassDecision>, { by: "jev" }>>;
      const codeDefects: Array<Record<string, unknown>> = [];
      const envIssues: string[] = [];
      let testDefectsCount = 0;

      const classified = failures.map((f, i) => {
        const obj = typeof f === "object" && f !== null ? (f as Record<string, unknown>) : { id: String(f) };
        const cls = jevVerdicts[i]!.decision.cls;
        const reason = failureInputs[i]!.reason;

        if (cls === "infra" || cls === "provider" || cls === "harness") {
          envIssues.push(reason);
          return { ...obj, class: "env_issue" };
        }
        // "When in doubt - code_defect"
        const defect = {
          file: typeof obj.file === "string" ? obj.file : "unknown",
          line: typeof obj.line === "number" ? obj.line : 1,
          severity: "high",
          evidence: reason,
          dimension: "correctness",
        };
        codeDefects.push(defect);
        return { ...obj, class: "code_defect" };
      });

      return {
        output: {
          failures: classified,
          code_defects: codeDefects,
          test_defects: testDefectsCount,
          env_issues: envIssues,
          code_defect_count: codeDefects.length,
        },
      };
    },
  } as NodeExecutor<ChainRuntime>);
}

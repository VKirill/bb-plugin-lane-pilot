import { observeStageChild } from "@lane-pilot/thread-observe";
import { bestEffort, outputText, redactKnown, redactKnownDeep, stringAt } from "@lane-pilot/kit";
import { spawnTextId } from "../../../platform/server";
import { runJudge } from "../../../critique/server";
import type { ServerCore } from "../../../contracts/server";
import {
  parseQaCases,
  parseQaVerdict,
  qaExpectFromRequest,
  qaJudgeVerdictOf,
  qaThreadPrompt,
  type QaExpect,
  type QaVerdict,
} from "../../models/qa-thread";
import { collectQaArtifacts } from "./qa-artifacts";

/**
 * Browser QA as a child BB thread that drives the BB browser (a desktop tab or a headless session with a live view)
 * through the Browser Automation plugin. The owner can open the thread and watch; before this the check ran a runner
 * script with its own Chrome on the QA machine, outside BB.
 */
export async function runQaThread(ctx: Pick<ServerCore, "bb" | "db" | "isDisposed">, input: {
  projectId: string; runId: string; pmThreadId: string; taskTitle: string; qaHostId: string; timeoutSec: number;
  url: string; cases: string[]; viewports: string; envClass: string; authorized: boolean; devServer?: string; vpnAddress?: string | null;
  agent: { providerId: string; model: string; effort: string; serviceTier?: "default" | "fast" | undefined };
  onSpawned?: (threadId: string, deadline: number) => void;
}): Promise<QaVerdict & { threadId: string; link: string }> {
  const { bb, db } = ctx;
  const expect = qaExpectFromRequest(input.cases, input.viewports);
  if (!expect) throw new Error("browser_qa_expectation_invalid");
  const pm = await bb.sdk.threads.get({ threadId: input.pmThreadId });
  const environmentId = stringAt(pm, "environmentId");
  if (!environmentId) throw new Error("browser_qa_thread_needs_pm_environment");
  const deadline = Date.now() + input.timeoutSec * 1000;
  // Env Catalog only for a check that has a login to read (J5); the account itself is named in the prompt.
  const extraCapabilities = parseQaCases(input.cases).logins.length
    ? { bbPlugins: ["env-catalog"], skills: ["env-catalog"] }
    : undefined;
  const run = await runJudge<(QaVerdict & { threadId: string; link: string }) | null>({
    bb,
    db,
    projectId: input.projectId,
    runId: input.runId,
    role: "browser-qa",
    taskTitle: `Browser check: ${input.taskTitle}`,
    pairs: [{ providerId: input.agent.providerId, model: input.agent.model }],
    effort: input.agent.effort,
    tier: input.agent.serviceTier === "fast" ? "fast" : "standard",
    checkCatalog: false,
    directServiceTier: input.agent.serviceTier ?? "default",
    extraCapabilities,
    errorPrefix: "browser_qa",
    timeoutCode: `browser_qa_thread_timeout_${input.timeoutSec}s`,
    stopOnError: false,
    environment: { type: "reuse", environmentId },
    stepsForRound: ({ helperPolicy }) => [{
      prompt: qaThreadPrompt(input),
      pluginMetadata: {
        role: "browser-qa",
        spawnId: `${input.runId}:${spawnTextId([input.taskTitle, input.url, ...input.cases].join("\n"))}`,
        lanePilotRunId: input.runId,
        parentPmThreadId: input.pmThreadId,
        helperMode: helperPolicy.mode,
      },
      awaitCustom: async (threadId) => {
        input.onSpawned?.(threadId, deadline);
        return awaitQaVerdict(ctx, threadId, deadline, input.timeoutSec, { projectId: input.projectId, runId: input.runId }, expect);
      },
    }],
    toVerdict: (results) => {
      const first = results[0];
      return first ? qaJudgeVerdictOf(first) : "not_run";
    },
  });
  const verdict = run.status === "ok" ? run.results[0] : null;
  // A reload stopped the wait, not the thread: the next load picks its verdict up (resumeBrowserQaThreads).
  if (!verdict) throw new Error("browser_qa_wait_interrupted_by_reload");
  return verdict;
}

/**
 * Waits for a check thread's verdict until the deadline; a thread still working then is stopped and the check is
 * blocked. Null when the plugin is unloaded meanwhile: the thread goes on and its verdict is still to be read.
 */
export async function awaitQaVerdict(ctx: Pick<ServerCore, "bb" | "isDisposed">, threadId: string, deadline: number, timeoutSec: number, scope?: { projectId: string; runId: string }, expect?: QaExpect | null)
  : Promise<(QaVerdict & { threadId: string; link: string }) | null> {
  const { bb } = ctx;
  const link = `@thread:${threadId}`;
  /** The verdict as read from the thread's output, redacted; artifact claims are verified against thread storage. */
  const read = async (): Promise<QaVerdict & { threadId: string; link: string }> => {
    const raw = (await bb.sdk.threads.output({ threadId })).output;
    const text = typeof raw === "string" ? raw : outputText(raw);
    const parsed = redactKnownDeep(parseQaVerdict(scope ? redactKnown(text) : text, expect));
    if (!expect || parsed.artifactClaims === undefined) return { ...parsed, threadId, link };
    const { artifactClaims, ...rest } = parsed;
    const evidence = await collectQaArtifacts(bb.sdk, threadId, expect, parsed.cases, artifactClaims);
    const notes = evidence.problems.length ? { artifactProblems: evidence.problems } : {};
    const verdict: QaVerdict = { ...rest, artifacts: evidence.refs, ...notes };
    // A pass is only as good as its screenshots: any unverified or missing evidence refuses it, findings kept.
    if (verdict.verdict === "passed" && evidence.problems.length) {
      return { verdict: "blocked", status: "block",
        summary: `browser_qa_evidence_failed:${evidence.problems.slice(0, 8).join(";")}`,
        cases: verdict.cases, findings: verdict.findings, evidence: verdict.evidence, artifacts: verdict.artifacts,
        artifactProblems: verdict.artifactProblems, threadId, link };
    }
    return { ...verdict, threadId, link };
  };
  while (Date.now() < deadline) {
    if (ctx.isDisposed()) return null;
    const observed = await observeStageChild(bb, threadId, Math.min(10_000, Math.max(1, deadline - Date.now())));
    if (ctx.isDisposed()) return null;
    if (observed.kind === "completed") return await read();
    if (observed.kind === "product_failure") return { verdict: "blocked", status: "block", summary: `browser_qa_thread_failed:${observed.via}:${observed.detail}`, cases: [], threadId, link };
  }
  // Past the deadline (also when adopted after a long outage): a finished thread still has its verdict.
  const last = await observeStageChild(bb, threadId, 1);
  if (last.kind === "completed") return await read();
  await bestEffort(ctx.bb.log, `browser qa thread stop ${threadId}`, bb.sdk.threads.stop({ threadId }), undefined);
  return { verdict: "blocked", status: "block", summary: `browser_qa_thread_timeout_${timeoutSec}s`, cases: [], threadId, link };
}

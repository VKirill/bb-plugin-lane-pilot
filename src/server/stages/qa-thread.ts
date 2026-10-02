import { observeStageChild } from "@lane-pilot/thread-observe";
import { writerExecutionSelection } from "../../jev-reasoning";
import { fullAccessSpawn } from "../pm-spawn";
import { helperChildPlacement, requireHelperSpawn, requiredPolicyField } from "../run-routing";
import { stringAt } from "../values";
import { outputText } from "../writer-task";
import type { ServerCore } from "../core";

export type QaVerdict = {
  verdict: "passed" | "failed" | "blocked";
  summary: string;
  cases: Array<{ case: string; viewport: string; result: "passed" | "failed" | "blocked"; note?: string }>;
};

/** The last fenced JSON block with a verdict; anything else is a blocked check, never a pass. */
export function parseQaVerdict(text: string): QaVerdict {
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)].map((match) => match[1]!).reverse();
  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block) as Partial<QaVerdict>;
      if (parsed.verdict !== "passed" && parsed.verdict !== "failed" && parsed.verdict !== "blocked") continue;
      const cases = Array.isArray(parsed.cases) ? parsed.cases.filter((row) => row && typeof row.case === "string") : [];
      // A pass needs every case passed on record; a bare «passed» proves nothing.
      const allPassed = cases.length > 0 && cases.every((row) => row.result === "passed");
      const verdict = parsed.verdict === "passed" && !allPassed ? "blocked" : parsed.verdict;
      return { verdict, summary: typeof parsed.summary === "string" ? parsed.summary : "", cases };
    } catch { continue; }
  }
  return { verdict: "blocked", summary: "browser_qa_thread_returned_no_verdict", cases: [] };
}

export function qaThreadPrompt(input: { url: string; cases: string[]; viewports: string; envClass: string; authorized: boolean; qaHostId: string }): string {
  return [
    "You are the Lane Pilot browser check for an accepted task. Check the site in a browser through BB and report a verdict.",
    "",
    `Target: ${input.url} (environment: ${input.envClass}${input.authorized ? ", side effects authorized" : ", no stateful side effects: do not submit, pay, delete or send"}).`,
    `Viewports (CSS width): ${input.viewports}.`,
    "Cases:",
    ...input.cases.map((item, index) => `${index + 1}. ${item}`),
    "",
    "How:",
    "1. Load the browser-automation skill.",
    `2. Run \`bb browser instances --host ${input.qaHostId} --json\`. If it lists an instance, open \`bb browser-automation open --backend desktop --machine ${input.qaHostId} --desktop <instance-id> --json\` (a visible BB tab); otherwise \`bb browser-automation open --backend local --headless --machine ${input.qaHostId} --json\` and copy its previewDirective into your message once, so the owner can watch.`,
    `   The browser runs on ${input.qaHostId}, which may not be the machine you run on. If the target is localhost or 127.0.0.1 and your machine (\`bb status\`) is not ${input.qaHostId}, share the port first with \`bb connect expose <port> --json\` and check the URL it returns.`,
    "3. For every viewport set the page width, open the target and go through every case. Take a fresh snapshot before using refs; take a screenshot as proof for each case and look at it.",
    "4. Close the session.",
    "Do not change any file. Do not guess: a case you could not check is blocked, with the reason.",
    "",
    "End with one fenced json block and nothing after it:",
    "```json",
    '{"verdict":"passed|failed|blocked","summary":"one paragraph","cases":[{"case":"…","viewport":"375","result":"passed|failed|blocked","note":"what you saw"}]}',
    "```",
    "verdict is passed only when every case passed on every viewport.",
  ].join("\n");
}

/**
 * Browser QA as a child BB thread that drives the BB browser (a desktop tab or a headless session with a live view)
 * through the Browser Automation plugin. The owner can open the thread and watch; before this the check ran a runner
 * script with its own Chrome on the QA machine, outside BB.
 */
export async function runQaThread(ctx: Pick<ServerCore, "bb" | "db" | "isDisposed">, input: {
  projectId: string; runId: string; pmThreadId: string; taskTitle: string; qaHostId: string; timeoutSec: number;
  url: string; cases: string[]; viewports: string; envClass: string; authorized: boolean;
  agent: { providerId: string; model: string; effort: string };
  onSpawned?: (threadId: string) => void;
}): Promise<QaVerdict & { threadId: string; link: string }> {
  const { bb, db } = ctx;
  const pm = await bb.sdk.threads.get({ threadId: input.pmThreadId });
  const environmentId = stringAt(pm, "environmentId");
  if (!environmentId) throw new Error("browser_qa_thread_needs_pm_environment");
  const helperPolicy = requireHelperSpawn({ bb, db, projectId: input.projectId, runId: input.runId });
  const placement = await helperChildPlacement({ bb, db, projectId: input.projectId, runId: input.runId, role: "browser-qa", taskTitle: `Browser check: ${input.taskTitle}` });
  const spawned = await fullAccessSpawn(bb, {
    ...placement,
    ...requiredPolicyField(bb, helperPolicy, input.agent.providerId),
    ...writerExecutionSelection(input.agent.providerId, input.agent.model, input.agent.effort, null),
    prompt: qaThreadPrompt(input),
    environment: { type: "reuse", environmentId },
    pluginMetadata: { role: "browser-qa", lanePilotRunId: input.runId, parentPmThreadId: input.pmThreadId, helperMode: helperPolicy.mode },
  } as Parameters<typeof fullAccessSpawn>[1]);
  const threadId = stringAt(spawned, "id");
  if (!threadId) throw new Error("browser_qa_thread_id_missing");
  input.onSpawned?.(threadId);
  const link = `@thread:${threadId}`;
  const deadline = Date.now() + input.timeoutSec * 1000;
  while (Date.now() < deadline && !ctx.isDisposed()) {
    const observed = await observeStageChild(bb, threadId, Math.min(10_000, Math.max(1, deadline - Date.now())));
    if (observed.kind === "completed") {
      const raw = (await bb.sdk.threads.output({ threadId })).output;
      return { ...parseQaVerdict(typeof raw === "string" ? raw : outputText(raw)), threadId, link };
    }
    if (observed.kind === "product_failure") return { verdict: "blocked", summary: `browser_qa_thread_failed:${observed.via}:${observed.detail}`, cases: [], threadId, link };
  }
  await bb.sdk.threads.stop({ threadId }).catch(() => undefined);
  return { verdict: "blocked", summary: `browser_qa_thread_timeout_${input.timeoutSec}s`, cases: [], threadId, link };
}

import { choice, choiceOf, defineJudgment, jev, type JevSettings } from "@lane-pilot/jev";
import type { CodeCritiqueResult } from "./code-critique";

/**
 * Cheap first pass before the code critic. A clear pass or fail is Jev's; a close call escalates to the critic.
 * Off, shadow or a failure is not a decision: the critic still runs.
 */
export const CRITIC_SCREEN_ID = "critique.screen";

export const criticScreenJudgment = defineJudgment<{ packet: string }, { call: "pass" | "fail" }>({
  id: CRITIC_SCREEN_ID,
  version: 1,
  defaultMode: "active",
  timeoutMs: 8_000,
  stateBuilder: (input) => ({ packet: input.packet.slice(0, 4_000) }),
  questions: () => ({
    call: choice(
      "Read `packet`: the task title, its acceptance lines, a short diff and the check exit codes. Is the change an obvious pass, an obvious fail, or too close to call?",
      {
        pass: "The diff plainly does what the acceptance lines ask, and every shown check exited 0. Nothing in the packet contradicts that.",
        fail: "The diff plainly misses an acceptance line, or a shown check exited non-zero for that work. Name it without guessing.",
        unsure: "The packet is mixed, incomplete, or a person would have to read the code to decide.",
      },
    ),
  }),
  thresholds: {
    min_p: { default: 0.8, min: 0.6, max: 0.95, about: "least probability of pass or fail; below it the code critic decides" },
  },
  decide(answers, t) {
    const pick = choiceOf(answers, "call");
    if (!pick || pick.p < t.min_p! || (pick.top !== "pass" && pick.top !== "fail")) return { escalate: "code-critic" };
    return { decision: { call: pick.top } };
  },
  fallback: () => ({ call: "pass" }),
  describe: (decision) => decision.call,
});

/** Only a verdict Jev itself settled skips the critic. Escalate, shadow and fallback do not. */
export function criticScreenRoute(verdict: { by: string; decision?: { call?: string } } | null | undefined): "pass" | "fail" | "llm" {
  if (verdict?.by !== "jev") return "llm";
  return verdict.decision?.call === "fail" ? "fail" : verdict.decision?.call === "pass" ? "pass" : "llm";
}

/** What the stage stores when Jev settled it, so repair and the stop rule read the same shape as a critic. */
export function critiqueFromScreen(call: "pass" | "fail"): CodeCritiqueResult {
  if (call === "pass") return { decision: "approve", summary: "jev: obvious pass", findings: [], status: "pass" };
  return {
    decision: "changes_requested",
    summary: "jev: obvious fail",
    status: "rework",
    findings: [{ id: "jev-screen", severity: "blocking", finding: "the change misses the acceptance shown to the screen", criterion: "acceptance", evidence: "jev screen" }],
  };
}

const clip = (text: string, max: number) => text.slice(0, max);

/** Title, acceptance, a short diff and check codes. The critic still sees the full packet when this stays unsure. */
export function criticScreenPacket(input: {
  task: { title: string; acceptance: unknown };
  evidence: { files: readonly { path: string; diff: string }[]; verification: readonly { command: string; exitCode: number }[] };
}): string {
  const diffs = input.evidence.files.slice(0, 8).map((file) => `${file.path}\n${clip(file.diff, 400)}`).join("\n");
  const checks = input.evidence.verification.slice(0, 8).map((row) => `${row.exitCode} ${row.command}`).join("\n");
  return clip([`title: ${input.task.title}`, `acceptance: ${clip(JSON.stringify(input.task.acceptance), 800)}`, diffs, checks].join("\n"), 4_000);
}

/** `null` means the critic runs: Jev is off, unsure, or did not answer. */
export async function screenCodeCritique(
  settings: Record<string, unknown>,
  input: { projectId: string; runId: string; taskId: string } & Parameters<typeof criticScreenPacket>[0],
): Promise<"pass" | "fail" | null> {
  const instance = jev();
  if (!instance?.enabled(settings as JevSettings)) return null;
  try {
    const verdict = await instance.judge(
      criticScreenJudgment,
      { packet: criticScreenPacket(input) },
      { projectId: input.projectId, runId: input.runId, subject: input.taskId, settings: settings as JevSettings },
    );
    const route = criticScreenRoute(verdict);
    return route === "llm" ? null : route;
  } catch {
    return null;
  }
}

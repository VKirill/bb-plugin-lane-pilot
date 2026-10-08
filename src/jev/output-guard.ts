import { redactKnown } from "../redact";
import { outputGuard, type OutputKind } from "./judgments/output-guard";
import type { Jev } from "./run";
import type { JevSettings } from "./thresholds";

/**
 * Before a writer's answer, an errand's report or a browser check's verdict is stored or shown (J-11): the redaction that always
 * ran, then the Jev guard `output.guard` on the redacted text (what leaves for the Jev API is the redacted text, never the raw
 * one). A block is kept in the plugin's KV for the self-repair watcher, which turns it into an incident (kind `guard`), and in
 * the log; the caller gets a placeholder in place of the text.
 */
export const GUARD_BLOCKED_KEY = "output-guard:blocked";
const KEEP_BLOCKS = 50;
const MIN_CHARS = 40;

export type GuardBlock = { at: number; kind: OutputKind; reason: string; projectId: string; runId: string | null; subject: string | null };
export type GuardResult = { blocked: false; text: string } | { blocked: true; text: string; reason: "secret" | "injection" };
export type GuardInput = { kind: OutputKind; text: string; projectId: string; runId?: string | null; subject?: string | null };
export type OutputGuard = (input: GuardInput) => Promise<GuardResult>;

export const withheldText = (kind: OutputKind, reason: "secret" | "injection"): string =>
  `[Lane Pilot withheld this ${kind} output: ${reason === "secret" ? "it appears to contain a secret value" : "it contains instructions aimed at the agent that reads it"}. It was not stored or shown; a self-repair incident was raised.]`;

export function createOutputGuard(deps: {
  jev(): Jev | null;
  settings(projectId: string): Promise<JevSettings>;
  kv: { get<T>(key: string): Promise<T | null | undefined>; set(key: string, value: never): Promise<unknown> };
  log(message: string): void;
  now?: () => number;
}): OutputGuard {
  return async (input) => {
    const text = redactKnown(input.text);
    const instance = deps.jev();
    if (!instance || text.trim().length < MIN_CHARS) return { blocked: false, text };
    try {
      const settings = await deps.settings(input.projectId).catch(() => ({} as JevSettings));
      if (!instance.enabled(settings)) return { blocked: false, text };
      const verdict = await instance.judge(outputGuard, { kind: input.kind, text }, { projectId: input.projectId, runId: input.runId ?? null, subject: input.subject ?? input.kind, settings });
      if (verdict.by !== "jev" || !verdict.decision.blocked) return { blocked: false, text };
      const reason = verdict.decision.reason;
      const block: GuardBlock = { at: (deps.now ?? Date.now)(), kind: input.kind, reason, projectId: input.projectId, runId: input.runId ?? null, subject: input.subject ?? null };
      const known = await deps.kv.get<GuardBlock[]>(GUARD_BLOCKED_KEY).catch(() => null);
      await deps.kv.set(GUARD_BLOCKED_KEY, [...(Array.isArray(known) ? known : []), block].slice(-KEEP_BLOCKS) as never).catch(() => undefined);
      deps.log(`Lane Pilot output guard blocked a ${input.kind} output (${reason}) in ${input.projectId}${input.runId ? ` run ${input.runId}` : ""}${input.subject ? ` ${input.subject}` : ""}`);
      return { blocked: true, text: withheldText(input.kind, reason), reason };
    } catch { return { blocked: false, text }; }
  };
}

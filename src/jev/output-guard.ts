import { sha256 } from "../stages/contract";
import { redactKnown } from "@lane-pilot/kit";
import { outputGuard, type OutputKind } from "./judgments/output-guard";
import type { Jev } from "./run";
import { resolveMode, type JevSettings } from "./thresholds";

/**
 * Before a writer's answer, an errand's report or a browser check's verdict is stored or shown (J-11): the redaction that always
 * ran, then the Jev guard `output.guard` on the redacted text (what leaves for the Jev API is the redacted text, never the raw
 * one). A block is kept in the plugin's KV for the self-repair watcher, which turns it into an incident (kind `guard`), and in
 * the log; the caller gets a placeholder in place of the text.
 *
 * What leaves for the Jev API is limited (audit 2026-10-08 round 3): in `shadow`, where nothing is blocked and the answer only
 * feeds the statistics, about one output in ten is asked about (the same text always gets the same answer to «sampled?»), at
 * most `SHADOW_CHARS` of it, and never a text that had a secret redacted or that talks about secrets and the environment.
 * In `active` every output is asked, up to `GUARD_CHARS`: the guard is the point there.
 */
export const GUARD_BLOCKED_KEY = "output-guard:blocked";
const KEEP_BLOCKS = 50;
const MIN_CHARS = 40;
/** Share of outputs a shadow guard asks about, and how much of each goes out. */
export const SHADOW_SAMPLE = 0.1;
export const SHADOW_CHARS = 2_000;
/** What counts as sensitive for a shadow guard: the secret itself, or text about the environment and credentials. */
const SENSITIVE = /\.env\b|env[_ -]?catalog|\benv_(?:get|set|list|request)|printenv|process\.env|BEGIN [A-Z ]*PRIVATE KEY|\b[A-Za-z0-9_]*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*\s*[=:]|\bBearer\s+[A-Za-z0-9._~+/-]{12,}|\bAuthorization:|\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b|\bxox[abpr]-[A-Za-z0-9-]{10,}/i;
export const looksSensitive = (raw: string, redacted: string): boolean => raw !== redacted || SENSITIVE.test(redacted);
/** The share of the unit interval a text falls on, the same every time, so a text is either always sampled or never. */
const unitOf = (text: string): number => parseInt(sha256(text).slice(0, 8), 16) / 0x1_0000_0000;
export const GUARD_STATS_KEY = "output-guard:stats";
const KEEP_DAYS = 14;
export type GuardStats = Record<string, { asked: number; notSampled: number; sensitive: number }>;

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
  /** In [0, 1): replaces the text-derived value the shadow sample is drawn with (tests). */
  random?: () => number;
}): OutputGuard {
  /** How many outputs were asked about and why the others were not, per UTC day; the cost of the calls is in the Jev receipts. */
  const count = async (field: "asked" | "notSampled" | "sensitive"): Promise<void> => {
    const day = new Date((deps.now ?? Date.now)()).toISOString().slice(0, 10);
    try {
      const known = await deps.kv.get<GuardStats>(GUARD_STATS_KEY).catch(() => null);
      const stats: GuardStats = known && typeof known === "object" ? { ...known } : {};
      const today = stats[day] ?? { asked: 0, notSampled: 0, sensitive: 0 };
      today[field] += 1;
      stats[day] = today;
      for (const old of Object.keys(stats).sort().slice(0, -KEEP_DAYS)) delete stats[old];
      await deps.kv.set(GUARD_STATS_KEY, stats as never);
    } catch { /* statistics only */ }
  };
  return async (input) => {
    const text = redactKnown(input.text);
    const instance = deps.jev();
    if (!instance) return { blocked: false, text };
    if (text.trim().length < MIN_CHARS) return { blocked: false, text };
    try {
      const settings = await deps.settings(input.projectId).catch(() => ({} as JevSettings));
      if (!instance.enabled(settings)) return { blocked: false, text };
      const shadow = resolveMode(outputGuard, settings) !== "active";
      if (shadow) {
        if (looksSensitive(input.text, text)) { await count("sensitive"); return { blocked: false, text }; }
        if ((deps.random ?? (() => unitOf(text)))() >= SHADOW_SAMPLE) { await count("notSampled"); return { blocked: false, text }; }
      }
      await count("asked");
      const verdict = await instance.judge(outputGuard, { kind: input.kind, text, ...(shadow ? { limit: SHADOW_CHARS } : {}) }, { projectId: input.projectId, runId: input.runId ?? null, subject: input.subject ?? input.kind, settings });
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

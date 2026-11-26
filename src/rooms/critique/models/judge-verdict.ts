import {
  applyRubric,
  extractModelJson,
  helperExit,
  isVerdictShape,
  normalizeVerdictInput,
  settleVerdict,
  verdictSchema,
  withoutDecision,
} from "@lane-pilot/workflow-engine";
import type { Verdict, VerdictKind, VerdictStatus } from "@lane-pilot/workflow-engine";
import { demoteUncited } from "./citations";
import type { Citation } from "./citations";

/**
 * The one closed verdict vocabulary every judge runner and parser returns:
 * - `pass`: checks/review passed
 * - `rework`: fixable findings returned to writer/PM
 * - `block`: hard stop requiring owner/approach change
 * - `not_run`: skipped, infra failure, timeout, empty/unreadable answer or honest exit
 */
export const JUDGE_VERDICTS = ["pass", "rework", "block", "not_run"] as const;
export type JudgeVerdict = (typeof JUDGE_VERDICTS)[number];

export type LegacyVerdictBridge<TLegacy> = {
  status: VerdictStatus;
  legacy: TLegacy;
  toVerdict: () => Verdict;
};

export type ParsedVerdict<TLegacy = never> =
  | { format: "unified"; status: VerdictStatus; verdict: Verdict; demoted: number; raw: Record<string, unknown> }
  | { format: "legacy"; status: VerdictStatus; verdict: Verdict; legacy: TLegacy; raw: Record<string, unknown> };

/**
 * The single settle/parse path for every verdict-shaped judge output (plan critique, code critique, specialist review):
 * extracts JSON, settles unified verdicts through `demoteUncited` + `applyRubric` + `settleVerdict`, or maps a legacy output.
 */
export function parseVerdictWithLegacy<TLegacy>(
  output: string,
  options: {
    kind: VerdictKind;
    cites?: Citation;
    normalize?: boolean;
    parseLegacy: (raw: unknown) => LegacyVerdictBridge<TLegacy>;
  },
): ParsedVerdict<TLegacy> {
  const extracted = extractModelJson(output);
  const raw = (options.normalize === false ? extracted : normalizeVerdictInput(extracted)) as Record<string, unknown>;
  if (isVerdictShape(raw)) {
    const cited = demoteUncited(verdictSchema.parse(withoutDecision(raw)), options.cites);
    const settled = settleVerdict(applyRubric(cited.verdict, options.kind), options.kind);
    return {
      format: "unified",
      status: settled.verdict.status,
      verdict: settled.verdict,
      demoted: settled.demoted + cited.demoted,
      raw,
    };
  }
  const bridged = options.parseLegacy(raw);
  return {
    format: "legacy",
    status: bridged.status,
    verdict: bridged.toVerdict(),
    legacy: bridged.legacy,
    raw,
  };
}

/** Re-settle code-critique findings after the cross-family verifier lowers refuted ones. */
export function settleCodeFindings(verdict: Verdict): Verdict {
  return settleVerdict(verdict, "code").verdict;
}

/** Validate and settle a unified QA verdict block (page findings need file and evidence, not a line). */
export function settleQaVerdict(raw: Record<string, unknown>): { status: VerdictStatus; verdict: Verdict } | null {
  const unified = verdictSchema.safeParse(raw);
  if (!unified.success) return null;
  const { verdict: settled } = settleVerdict(unified.data, "specialist");
  return { status: settled.status, verdict: settled };
}

export type JudgeVerdictResult<T = unknown> = {
  verdict: JudgeVerdict;
  parsed?: T;
  reason?: string;
};

/**
 * The one top-level verdict parser for every judge: normalizes skipped/error/empty/honest-exit/unreadable
 * outcomes to `not_run` and delegates valid model answers to the judge's parser to yield `pass|rework|block|not_run`.
 */
export function parseJudgeVerdict<T>(input: {
  output?: string | null;
  parse?: (output: string) => T;
  toVerdict?: (parsed: T) => JudgeVerdict;
  skipped?: boolean;
  skipReason?: string;
  error?: unknown;
  throwOnUnreadable?: boolean;
}): JudgeVerdictResult<T> {
  if (input.skipped) return { verdict: "not_run", reason: input.skipReason ?? "skipped" };
  if (input.error !== undefined) {
    return { verdict: "not_run", reason: input.error instanceof Error ? input.error.message : String(input.error) };
  }
  const text = input.output;
  if (typeof text !== "string" || !text.trim()) return { verdict: "not_run", reason: "empty_output" };
  const exit = helperExit(text);
  if (exit) {
    if (input.throwOnUnreadable) throw new Error(exit);
    return { verdict: "not_run", reason: exit };
  }
  if (!input.parse) {
    try {
      const raw = normalizeVerdictInput(extractModelJson(text)) as Record<string, unknown>;
      if (isVerdictShape(raw)) {
        const parsed = verdictSchema.parse(withoutDecision(raw));
        return { verdict: parsed.status, parsed: parsed as unknown as T };
      }
      return { verdict: "not_run", reason: "verdict_unrecognized" };
    } catch (cause) {
      if (input.throwOnUnreadable) throw cause;
      return { verdict: "not_run", reason: cause instanceof Error ? cause.message : String(cause) };
    }
  }
  try {
    const parsed = input.parse(text);
    const verdict = input.toVerdict ? input.toVerdict(parsed) : inferVerdict(parsed);
    return { verdict, parsed };
  } catch (cause) {
    if (input.throwOnUnreadable) throw cause;
    return { verdict: "not_run", reason: cause instanceof Error ? cause.message : String(cause) };
  }
}

function inferVerdict(parsed: unknown): JudgeVerdict {
  if (!parsed || typeof parsed !== "object") return "not_run";
  const record = parsed as Record<string, unknown>;
  if (record.status === "pass" || record.status === "rework" || record.status === "block") return record.status;
  if (record.decision === "approve") return "pass";
  if (record.decision === "changes_requested") return "rework";
  if (record.decision === "block") return "block";
  return "not_run";
}

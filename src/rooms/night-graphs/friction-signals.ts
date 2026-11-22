import { redactKnown } from "@lane-pilot/kit";
import { maskPii, scrubQuote } from "../anamnesis";

export type FrictionSignalKind =
  | "human_gate_bypass_or_abort"
  | "owns_paths_rejection"
  | "step_skipped_or_failed"
  | "user_simplification_request";

export type FrictionSignal = {
  readonly kind: FrictionSignalKind;
  readonly stageArchetype: string;
  readonly workflowId: string | null;
  readonly nodeId?: string;
  readonly summary: string;
};

export type FrictionLogLevel = "debug" | "info" | "warn" | "error" | "silent";

export type ExtractFrictionInput = {
  readonly workflowId?: string | null;
  readonly wfStepSignals?: ReadonlyArray<{
    runId: string;
    workflowId?: string | null;
    nodeId: string;
    state: string;
    answerKind: string | null;
    error: string | null;
  }>;
  readonly gateRejections?: ReadonlyArray<{
    taskId: string;
    gate: string;
    status: string;
    attempt: number;
  }>;
  readonly correctionTexts?: readonly string[];
  readonly userLines?: readonly string[];
  readonly log?: (message: string) => void;
  readonly logLevel?: FrictionLogLevel;
};

const MAX_SIGNALS = 12;
const SUMMARY_CLIP = 280;

const LOG_RANK: Readonly<Record<FrictionLogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 99,
};

const RU_OVER_CONSTRAINT_RE =
  /(?:это\s+лишн|лишн\p{L}*\s+(?:шаг|этап|гейт|узел|проверк)|сдела\p{L}*\s+проще|проще\s+без|без\s+cms|не\s+нужн\p{L}*\s+(?:cms|миграц|импорт|шаг|этап|гейт)|обойти\s+(?:гейт|шаг|этап)|невозможно\s+обойти|глух\p{L}*\s+гейт|пропусти\p{L}*\s+(?:этот\s+)?(?:шаг|этап|гейт)|зачем\s+тут|слишком\s+сложн|упрости\p{L}*\s+(?:процесс|пайплайн|шаг|воркфлоу|схем)|избыточн\p{L}*\s+(?:шаг|этап|гейт|ограничен))/iu;

const EN_OVER_CONSTRAINT_RE =
  /(?:unnecessary\s+(?:step|stage|gate|check)|too\s+rigid|cannot\s+bypass|can't\s+bypass|skip\s+this\s+(?:step|gate|stage)|without\s+cms|no\s+cms\s+needed|overkill|make\s+it\s+simpler|redundant\s+(?:step|gate|stage|check)|over[- ]?constrain)/iu;

const STEP_FAILURE_FRICTION_RE =
  /(?:missing\s+input|owns[-_]paths|unwanted|unnecessary|skip|redundant|лишн|отсутству|не\s+нужн|обойти|пропущ)/iu;

const STAGE_RULES: ReadonlyArray<readonly [string, RegExp]> = [
  ["verification", /(?:qa|verify|verification|review|critique|audit|test|check|провер|ревью|аудит|тест)/iu],
  ["implementation", /(?:writer|implement|build|code|owns[-_]paths|migrat|код|миграц|сборк|имплемент)/iu],
  ["design", /(?:design|layout|ui|ux|figma|cms|вёрст|верст|дизайн|макет|прототип)/iu],
  ["copy", /(?:copy|headline|editorial|content|копирайт|текст|заголов|оффер)/iu],
  ["references", /(?:reference|research|competitor|референс|ресёрч|конкурент|аналог)/iu],
  ["intake", /(?:intake|brief|scope|discover|бриф|запрос|скоуп)/iu],
];

function shouldEmit(level: FrictionLogLevel, override?: FrictionLogLevel, hasLogger = false): boolean {
  const envRaw = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.LOG_LEVEL;
  const envLevel = envRaw?.trim().toLowerCase() as FrictionLogLevel | undefined;
  const effective = override ?? (envLevel && envLevel in LOG_RANK ? envLevel : hasLogger ? "debug" : "info");
  return LOG_RANK[level] >= LOG_RANK[effective];
}

function scrubPathsAndIds(raw: string): string {
  return raw
    .replace(/(?:\/Users\/|\/home\/|\/var\/folders\/|\/private\/tmp\/)[^\s"'`)]+/g, "[path]")
    .replace(/[A-Za-z]:\\[^\s"'`)]+/g, "[path]")
    .replace(/\bproj_[a-z0-9_-]{4,}\b/gi, "[project]")
    .replace(/\bhost_[a-z0-9_-]{4,}\b/gi, "[host]");
}

function maskSummary(raw: string, max = SUMMARY_CLIP): string {
  return maskPii(scrubQuote(redactKnown(scrubPathsAndIds(raw)), max)).text.trim();
}

function inferStageArchetype(hints: string): string {
  for (const [archetype, re] of STAGE_RULES) if (re.test(hints)) return archetype;
  return "general";
}

/** Returns true when a user/correction message signals an unnecessary step, rigid gate, or over-constrained process. */
export function hasOverConstraintPhrase(text: string): boolean {
  const trimmed = text.trim();
  return Boolean(trimmed) && (RU_OVER_CONSTRAINT_RE.test(trimmed) || EN_OVER_CONSTRAINT_RE.test(trimmed));
}

/** Deterministically extracts deduplicated over-constraint friction signals from workflow steps, gate rejections, and user remarks. */
export function extractFrictionSignals(input: ExtractFrictionInput): FrictionSignal[] {
  const signals: FrictionSignal[] = [];
  const seen = new Set<string>();
  const push = (signal: FrictionSignal) => {
    if (signals.length >= MAX_SIGNALS || !signal.summary) return;
    const key = `${signal.kind}|${signal.stageArchetype}|${signal.workflowId ?? ""}|${signal.nodeId ?? ""}|${signal.summary}`;
    if (seen.has(key)) return;
    seen.add(key);
    signals.push(signal);
  };

  const reworkCounts = new Map<string, number>();
  for (const step of input.wfStepSignals ?? []) {
    if (step.answerKind === "rework") reworkCounts.set(step.nodeId, (reworkCounts.get(step.nodeId) ?? 0) + 1);
  }

  for (const step of input.wfStepSignals ?? []) {
    const workflowId = step.workflowId ?? input.workflowId ?? null;
    const stageArchetype = inferStageArchetype(`${step.nodeId} ${workflowId ?? ""} ${step.error ?? ""}`);
    if (step.answerKind === "skip" || step.answerKind === "abort") {
      const detail = step.error ? `: ${step.error}` : "";
      push({
        kind: "human_gate_bypass_or_abort",
        stageArchetype,
        workflowId,
        nodeId: step.nodeId,
        summary: maskSummary(`Human gate ${step.nodeId} answered '${step.answerKind}'${detail}`),
      });
      continue;
    }
    const reworkCount = reworkCounts.get(step.nodeId) ?? 0;
    if (step.answerKind === "rework" && reworkCount >= 2) {
      push({
        kind: "human_gate_bypass_or_abort",
        stageArchetype,
        workflowId,
        nodeId: step.nodeId,
        summary: maskSummary(`Human gate ${step.nodeId} repeated rework (${reworkCount}x)`),
      });
      continue;
    }
    if (step.state === "skipped" || (step.state === "failed" && (STEP_FAILURE_FRICTION_RE.test(step.error ?? "") || hasOverConstraintPhrase(step.error ?? "")))) {
      const detail = step.error ? `: ${step.error}` : "";
      push({
        kind: "step_skipped_or_failed",
        stageArchetype,
        workflowId,
        nodeId: step.nodeId,
        summary: maskSummary(`Step ${step.nodeId} ${step.state}${detail}`),
      });
    }
  }

  for (const gate of input.gateRejections ?? []) {
    if (gate.gate !== "owns-paths" || (gate.status !== "rejected" && gate.status !== "failed")) continue;
    push({
      kind: "owns_paths_rejection",
      stageArchetype: "implementation",
      workflowId: input.workflowId ?? null,
      summary: maskSummary(`Writer blocked by narrow owns-paths gate (task ${gate.taskId}, attempt ${gate.attempt})`),
    });
  }

  for (const line of [...(input.correctionTexts ?? []), ...(input.userLines ?? [])]) {
    if (!hasOverConstraintPhrase(line)) continue;
    const summary = maskSummary(line, SUMMARY_CLIP);
    if (!summary) continue;
    push({
      kind: "user_simplification_request",
      stageArchetype: inferStageArchetype(`${input.workflowId ?? ""} ${line}`),
      workflowId: input.workflowId ?? null,
      summary,
    });
  }

  if (signals.length > 0 && input.log && shouldEmit("debug", input.logLevel, true)) {
    const kinds = [...new Set(signals.map((s) => s.kind))];
    input.log(`DEBUG [nightGraphs.friction] detected ${redactKnown(JSON.stringify({ workflowId: input.workflowId ?? null, count: signals.length, kinds }))}`);
  }
  return signals;
}

import { listMemory } from "@lane-pilot/memory-core";
import { PM_CORE_TOOLS, PM_FAMILY_TOOLS } from "../platform/server";
import { pmRulesOf } from "../learning";
import { getAttempt, getReasoningTrace, HARNESS_VERSION, skillMetricSkillsForAttempt, type LanePilotDatabase } from "../storage";

/**
 * Session and terminal parity (SMA m_tl_terminal_parity): for one attempt, six layers — hooks,
 * memory, rules, skills, permissions, model — each line saying whether the BB session the attempt
 * ran in and a terminal session in the same project got the same layer. Read-only report.
 */
export const PARITY_LAYERS = ["hooks", "memory", "rules", "skills", "permissions", "model"] as const;
export type ParityLayer = (typeof PARITY_LAYERS)[number];
export type ParityLayerSet = Record<ParityLayer, readonly string[]>;
export type ParityLine = { layer: ParityLayer; same: boolean; detail: string };

const diff = (a: readonly string[], b: readonly string[]) => {
  const left = a.filter((item) => !b.includes(item)).sort();
  const right = b.filter((item) => !a.includes(item)).sort();
  return { onlySession: left, onlyTerminal: right };
};

export function terminalParity(session: ParityLayerSet, terminal: ParityLayerSet): ParityLine[] {
  return PARITY_LAYERS.map((layer) => {
    const gaps = diff(session[layer], terminal[layer]);
    const same = gaps.onlySession.length === 0 && gaps.onlyTerminal.length === 0;
    const detail = same
      ? `${new Set(session[layer]).size} entr${new Set(session[layer]).size === 1 ? "y" : "ies"}`
      : [
          gaps.onlySession.length ? `only in the session: ${gaps.onlySession.join(", ")}` : "",
          gaps.onlyTerminal.length ? `only in the terminal: ${gaps.onlyTerminal.join(", ")}` : "",
        ].filter(Boolean).join("; ");
    return { layer, same, detail };
  });
}

/** The six layers as the attempt's records show them: what its session was given. */
export function attemptSessionLayers(db: LanePilotDatabase, attemptId: string): ParityLayerSet | null {
  const attempt = getAttempt(db, attemptId);
  if (!attempt) return null;
  const trace = getReasoningTrace(db, attemptId);
  const context = trace?.dispatchContext;
  return {
    hooks: [attempt.harness_version ?? "unknown"],
    memory: context?.memoryPicked ?? [],
    rules: context?.rulesPicked?.picked ?? [],
    skills: skillMetricSkillsForAttempt(db, attemptId),
    permissions: [...PM_FAMILY_TOOLS, ...PM_CORE_TOOLS],
    model: trace ? [`${trace.providerId}/${trace.model}`] : [],
  };
}

/** The six layers a terminal session in the project gets today (skills and model are passed by the caller, who knows the catalog and the configured pick). */
export function terminalSessionLayers(input: {
  db: LanePilotDatabase;
  projectId: string;
  skills: readonly string[];
  model: string;
  harnessVersion?: string;
}): ParityLayerSet {
  return {
    hooks: [input.harnessVersion ?? HARNESS_VERSION],
    memory: listMemory(input.db, input.projectId, {}, 500, "subagent").map((record) => record.id),
    rules: pmRulesOf(input.db, input.projectId).map((rule) => rule.id),
    skills: [...input.skills],
    permissions: [...PM_FAMILY_TOOLS, ...PM_CORE_TOOLS],
    model: [input.model],
  };
}

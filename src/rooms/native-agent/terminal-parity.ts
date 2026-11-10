import { listMemory } from "@lane-pilot/memory-core";
import { pmRulesOf } from "../learning";
import { getAttempt, getReasoningTrace, HARNESS_VERSION, skillMetricSkillsForAttempt, type LanePilotDatabase } from "../storage";

/**
 * Session and terminal parity (SMA m_tl_terminal_parity): for one attempt, six layers — hooks,
 * memory, rules, skills, permissions, model — each line saying whether the BB session the attempt
 * ran in and a terminal session in the same project got the same layer. Read-only report.
 */
export const PARITY_LAYERS = ["hooks", "memory", "rules", "skills", "permissions", "model"] as const;
export type ParityLayer = (typeof PARITY_LAYERS)[number];
/** A layer is a list of entries, or null when that side has no record of it: such a layer is reported «not compared», never «same». */
export type ParityLayerSet = Record<ParityLayer, readonly string[] | null>;
export type ParityLine = { layer: ParityLayer; same: boolean | null; detail: string };

/** Why a layer is not compared: the attempt records no permission policy and a terminal's tool list is not readable from here. */
const NOT_COMPARED: Partial<Record<ParityLayer, string>> = {
  permissions: "not compared: the attempt records no tool permissions, and a terminal session's tool list is not visible to Lane Pilot",
};

const diff = (a: readonly string[], b: readonly string[]) => {
  const left = a.filter((item) => !b.includes(item)).sort();
  const right = b.filter((item) => !a.includes(item)).sort();
  return { onlySession: left, onlyTerminal: right };
};

export function terminalParity(session: ParityLayerSet, terminal: ParityLayerSet): ParityLine[] {
  return PARITY_LAYERS.map((layer): ParityLine => {
    const left = session[layer];
    const right = terminal[layer];
    if (left === null || right === null) return { layer, same: null, detail: NOT_COMPARED[layer] ?? "not compared: one side has no record of this layer" };
    const gaps = diff(left, right);
    const same = gaps.onlySession.length === 0 && gaps.onlyTerminal.length === 0;
    const detail = same
      ? `${new Set(left).size} entr${new Set(left).size === 1 ? "y" : "ies"}`
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
    permissions: null,
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
    permissions: null,
    model: [input.model],
  };
}

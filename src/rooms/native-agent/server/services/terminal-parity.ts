import { listMemory } from "@lane-pilot/memory-core";
import { getAttempt, getReasoningTrace, HARNESS_VERSION, skillMetricSkillsForAttempt, type LanePilotDatabase } from "../../../storage";
import { HELPER_DISALLOWED_TOOLS } from "../../models/claude-guard";
import { permissionEntries, type ParityLayerSet } from "../../models/terminal-parity";

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
    permissions: context?.permissions ?? null,
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
    rules: [],
    skills: [...input.skills],
    // The PM session has no role profile to narrow: its list is the guard's disallowed tools over an open
    // policy (SMA m_tl_terminal_parity). A writer's recorded list still diffs where its policy is tighter.
    permissions: permissionEntries({ policy: null, disallowedTools: HELPER_DISALLOWED_TOOLS }),
    model: [input.model],
  };
}

import { TRAJECTORY_INTERVENTION_KINDS, type TrajectoryInterventionKind } from "@lane-pilot/contracts";
import { redactKnown } from "@lane-pilot/kit";
import { shouldEmitSkillLog, type SkillCatalogItem, type SkillIntentLogLevel } from "./skill-intent";

/**
 * Append-only ledger of standardized owner trajectory maneuvers in chats and runs
 * (skill requests, rule additions, step insertions, reference branch picks, variant choices).
 */
export const TRAJECTORY_DELTA_TABLE = "lane_pilot_trajectory_delta";

export { TRAJECTORY_INTERVENTION_KINDS, type TrajectoryInterventionKind };

export type TrajectoryDeltaRow = {
  readonly id: string;
  readonly projectId: string | null;
  readonly threadId: string | null;
  readonly workflowId: string | null;
  readonly stageArchetype: string;
  readonly interventionKind: TrajectoryInterventionKind;
  readonly resolvedSkills: string[];
  readonly maskedSummary: string;
  readonly ownerAccepted: boolean;
  readonly processedAt: number | null;
  readonly createdAt: number;
};

export type RecordTrajectoryDeltaInput = {
  readonly id?: string;
  readonly projectId?: string | null;
  readonly threadId?: string | null;
  readonly workflowId?: string | null;
  readonly stageArchetype?: string;
  readonly interventionKind: TrajectoryInterventionKind;
  readonly rawSummary: string;
  readonly resolvedSkills?: readonly string[];
  readonly catalog?: readonly SkillCatalogItem[];
  readonly ownerAccepted?: boolean;
  readonly now?: number;
  readonly log?: (message: string) => void;
  readonly warn?: (message: string) => void;
  readonly logLevel?: SkillIntentLogLevel;
};

export type RecordTrajectoryDeltaResult = {
  readonly status: "recorded" | "duplicate" | "rejected";
  readonly row: TrajectoryDeltaRow | null;
  readonly reason?: string;
};

const KIND_SET = new Set<string>(TRAJECTORY_INTERVENTION_KINDS);
export const TRAJECTORY_DELTA_SUMMARY_CLIP = 600;

export const isValidInterventionKind = (kind: string): boolean => KIND_SET.has(kind);

export function emitTrajectoryLog(
  sink: ((message: string) => void) | undefined,
  level: "debug" | "info" | "warn" | "error",
  event: string,
  payload: Record<string, unknown>,
  override?: SkillIntentLogLevel,
): void {
  if (!sink || !shouldEmitSkillLog(level, override, true)) return;
  sink(redactKnown(`${level.toUpperCase()} [errands.trajectoryDelta] ${event} ${JSON.stringify(payload)}`));
}

export const normalizeStage = (raw: string | undefined): string => {
  const slug = (raw ?? "general").trim().toLowerCase().replace(/[^a-z0-9-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return (slug || "general").slice(0, 64);
};

export const parseSkills = (json: string | null | undefined): string[] => {
  try {
    const parsed = json ? (JSON.parse(json) as unknown) : [];
    return Array.isArray(parsed) ? parsed.map((s) => String(s)).filter(Boolean) : [];
  } catch { return []; }
};

export const toTrajectoryDeltaRow = (raw: Record<string, unknown>): TrajectoryDeltaRow => ({
  id: String(raw.id), projectId: (raw.project_id as string | null) ?? null,
  threadId: (raw.thread_id as string | null) ?? null, workflowId: (raw.workflow_id as string | null) ?? null,
  stageArchetype: String(raw.stage_archetype), interventionKind: String(raw.intervention_kind) as TrajectoryInterventionKind,
  resolvedSkills: parseSkills(raw.resolved_skills_json as string | null), maskedSummary: String(raw.masked_summary),
  ownerAccepted: Number(raw.owner_accepted) === 1,
  processedAt: raw.processed_at === null || raw.processed_at === undefined ? null : Number(raw.processed_at),
  createdAt: Number(raw.created_at),
});

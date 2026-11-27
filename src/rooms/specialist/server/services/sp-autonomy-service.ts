import { AUTONOMY_CLASSES, isAutonomyClass, type AutonomyClass } from "@lane-pilot/contracts";
import type { SpecialistAutonomyRow } from "../../../contracts";
import type { LanePilotDatabase } from "../../../storage";
import { loadSpPolicy } from "../../tool-tiers";
import { getAutonomyRow, grantAutonomy, revokeAutonomy, setAutonomyRowLevel } from "../repositories/sp-autonomy-grants";
import type { SpOutcomeLogger } from "../repositories/sp-outcomes";
import { buildAutonomy } from "./sp-detail";

const LEVEL_RANK: Record<AutonomyClass, number> = {
  [AUTONOMY_CLASSES[0]]: 0,
  [AUTONOMY_CLASSES[1]]: 1,
  [AUTONOMY_CLASSES[2]]: 2,
};

export interface SetAutonomyInput {
  projectId: string;
  domain: string;
  actionClass: string;
  level: AutonomyClass;
  reason?: string;
}

export interface SetAutonomyDeps {
  db: LanePilotDatabase;
  now?: () => number;
  log?: SpOutcomeLogger;
}

export type SetAutonomyResult =
  | { ok: true; autonomy: SpecialistAutonomyRow[] }
  | { ok: false; reason: string };

/**
 * Updates an action class's autonomy level on behalf of the owner.
 * Lowering revokes via `revokeAutonomy`; raising checks freeze and sample/confidence gates via `grantAutonomy`.
 */
export function setSpecialistAutonomy(deps: SetAutonomyDeps, input: SetAutonomyInput): SetAutonomyResult {
  const nowMs = deps.now ? deps.now() : Date.now();
  const existing = getAutonomyRow(deps.db, input.projectId, input.domain, input.actionClass);
  const frozen = existing !== null && existing.frozen_until !== null && existing.frozen_until > nowMs;

  const policyDefault = loadSpPolicy().autonomy?.default_class;
  const fallbackLevel: AutonomyClass = isAutonomyClass(policyDefault) ? policyDefault : "propose";
  const currentLevel: AutonomyClass =
    existing && isAutonomyClass(existing.autonomy_class)
      ? existing.autonomy_class === "bounded_auto" && (frozen || existing.high_risk === 1)
        ? "propose"
        : existing.autonomy_class
      : fallbackLevel;

  const currentRank = LEVEL_RANK[currentLevel];
  const targetRank = LEVEL_RANK[input.level];

  if (targetRank > currentRank) {
    if (frozen) {
      deps.log?.warn?.(
        `[specialist] autonomy refused project=${input.projectId} domain=${input.domain} class=${input.actionClass} level=${input.level} reason=frozen`,
      );
      return { ok: false, reason: "frozen" };
    }
    if (input.level === "bounded_auto") {
      const granted = grantAutonomy(
        deps.db,
        {
          projectId: input.projectId,
          domain: input.domain,
          actionClass: input.actionClass,
          by: "owner",
          reason: input.reason,
          now: nowMs,
          requireGates: true,
        },
        deps.log,
      );
      if (!granted.ok) return { ok: false, reason: granted.reason };
    } else {
      setAutonomyRowLevel(deps.db, {
        projectId: input.projectId,
        domain: input.domain,
        actionClass: input.actionClass,
        level: "propose",
        now: nowMs,
      });
    }
  } else if (targetRank < currentRank) {
    revokeAutonomy(
      deps.db,
      {
        projectId: input.projectId,
        domain: input.domain,
        actionClass: input.actionClass,
        reason: input.reason,
        now: nowMs,
      },
      deps.log,
    );
    if (input.level === "observe") {
      setAutonomyRowLevel(deps.db, {
        projectId: input.projectId,
        domain: input.domain,
        actionClass: input.actionClass,
        level: "observe",
        now: nowMs,
      });
    }
  } else if (!existing) {
    setAutonomyRowLevel(deps.db, {
      projectId: input.projectId,
      domain: input.domain,
      actionClass: input.actionClass,
      level: input.level === "bounded_auto" ? "propose" : input.level,
      now: nowMs,
    });
  }

  deps.log?.info?.(
    `[specialist] autonomy project=${input.projectId} domain=${input.domain} class=${input.actionClass} level=${input.level}`,
  );
  return {
    ok: true,
    autonomy: buildAutonomy(deps.db, input.projectId, input.domain, nowMs),
  };
}

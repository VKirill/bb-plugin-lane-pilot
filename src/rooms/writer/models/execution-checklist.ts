import { fileAllowedByOwns } from "@lane-pilot/kit";
import { failureFingerprint } from "../../contracts/failure-class";

/** The attempt's execution checklist, all flags in one object (sma ag_checklist). */
export function executionChecklist(input: {
  markers: { approach: string | null; lesson: string | null; noLessonReason: string | null };
  planFact: { check?: { items?: Array<{ item?: unknown; evidence?: unknown }> } | null } | null;
  priorReasons: string[]; produced: string[]; ownsPaths: string[]; referenceTestEdits: string[];
}): Record<string, unknown> {
  const lastReason = input.priorReasons[input.priorReasons.length - 1] ?? null;
  const stagnant = lastReason !== null && input.priorReasons.length > 1
    && failureFingerprint(input.priorReasons[input.priorReasons.length - 2]) === failureFingerprint(lastReason);
  return {
    promise: { approach: input.markers.approach !== null, lesson: input.markers.lesson ?? null, noLessonReason: input.markers.noLessonReason ?? null,
      planFactUnproven: (input.planFact?.check?.items ?? []).filter((item) => !item.evidence).map((item) => String(item.item)).slice(0, 20) },
    stagnation: { sameKeyTurns: stagnant, lastFailureReason: lastReason?.slice(0, 300) ?? null },
    scope: { outsideOwnsPaths: input.produced.filter((path) => !fileAllowedByOwns(path, input.ownsPaths)).slice(0, 50) },
    referenceTestEdits: input.referenceTestEdits,
  };
}

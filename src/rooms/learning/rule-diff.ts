import { listRuleProposals } from "@lane-pilot/run-insights";
import type { Db } from "./store";

/** The project's accepted rules that bind writers (audience `writer` or `both`), read for the writer's reflex lines. */

/** The project's accepted rules a writer's diff must hold, capped at one judgment's questions. */
export function writerDiffRules(db: Db, projectId: string): string[] {
  return listRuleProposals(db as never, projectId, { state: "accepted", limit: 48 })
    .filter((rule) => rule.audience !== "pm" && rule.memoryId !== null)
    .map((rule) => rule.rule);
}

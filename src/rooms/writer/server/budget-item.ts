import { tableExists, type OwnerItemSweep } from "../../owner-waiting";
import { getRun, getRunSettingsScopes, loadProjectSettings } from "../../storage";
import type { WriterStateApi } from "./state";

const RUN_BUDGET_ITEM_PREFIX = "run-budget:";

/** The owner-item key of a spent run budget: `run-budget:<run>`. */
export const runBudgetItemKey = (runId: string) => `${RUN_BUDGET_ITEM_PREFIX}${runId}`;

/**
 * The spent-budget row goes when the run closes, or when the owner raised the run.max_* limit far enough for the
 * budget check to pass again (runBudgetFor rebuilds the budget over the new limits, so a raise is visible here).
 */
export const budgetSpentSweep = (services?: { runBudgetFor?: WriterStateApi["runBudgetFor"] }): OwnerItemSweep => (db, item) => {
  if (!item.key.startsWith(RUN_BUDGET_ITEM_PREFIX) || !tableExists(db, "lane_pilot_run")) return null;
  const runId = item.key.slice(RUN_BUDGET_ITEM_PREFIX.length);
  const run = getRun(db as never, runId);
  if (!run || run.closed_at !== null) return "janitor:run closed";
  if (!services?.runBudgetFor) return null;
  const settings = loadProjectSettings(db as never, run.project_id, getRunSettingsScopes(db as never, runId));
  return services.runBudgetFor(runId, settings).check().ok ? "janitor:limit raised" : null;
};

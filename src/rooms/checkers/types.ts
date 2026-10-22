import { createHash } from "node:crypto";
import type { TaskV2 } from "../contracts";

/**
 * Checking the checkers (SMA atlas D1-4, rule «which of your key checks have you seen go red on purpose?»): known defects are planted in
 * real accepted candidates, every checker is run on them, and the hit or miss of each checker per defect class goes into a scorecard.
 */
export const CHECKERS = ["verification", "ownership", "contract_lint", "plan_fact", "code_critic", "plan_critic"] as const;
export type CheckerId = (typeof CHECKERS)[number];
/** The checkers that are code: no model, no cost. The drill runs only these. */
export const CODE_CHECKERS: readonly CheckerId[] = ["verification", "ownership", "contract_lint", "plan_fact"];
export const MODEL_CHECKERS: readonly CheckerId[] = ["code_critic", "plan_critic"];

export const DEFECT_CLASSES = [
  "test_assertion_deleted", "off_by_one", "outside_owns", "swallowed_error", "masked_check", "acceptance_missing", "hardcoded_value", "broken_import",
] as const;
export type DefectClass = (typeof DEFECT_CLASSES)[number];

/**
 * Who must catch each class by design. A class whose only catcher is the code critic is the gap the code checks leave (a deleted assertion
 * leaves every test green); a class with a code catcher turns the drill red when that catcher stops catching it.
 */
export const EXPECTED_CATCHERS: Readonly<Record<DefectClass, readonly CheckerId[]>> = {
  test_assertion_deleted: ["code_critic"],
  off_by_one: ["verification"],
  outside_owns: ["ownership"],
  swallowed_error: ["code_critic"],
  masked_check: ["contract_lint"],
  acceptance_missing: ["plan_fact"],
  hardcoded_value: ["code_critic"],
  broken_import: ["verification"],
};

/** Contract-level classes damage the task's contract, not the diff; the other classes damage the diff. */
export const CONTRACT_CLASSES: readonly DefectClass[] = ["masked_check"];

/** Which checker looks at which class at all (a lint does not read a diff, the ownership check does not read a contract). */
export function applies(checker: CheckerId, defectClass: DefectClass): boolean {
  const contract = CONTRACT_CLASSES.includes(defectClass);
  switch (checker) {
    case "verification": return true;
    case "ownership": case "plan_fact": case "code_critic": return !contract;
    case "contract_lint": case "plan_critic": return contract;
  }
}

export type FileChange = { path: string; before: string | null; after: string | null };

/** A real accepted candidate, ready to have defects planted in it: the contract and the files the accepted solution changed. */
export type PlantInput = {
  taskId: string;
  contract: TaskV2;
  changes: FileChange[];
  /** Where the candidate comes from (a bench task, a hub task, a fixture). */
  source: string;
};

export type PlantedDefect = {
  id: string;
  class: DefectClass;
  taskId: string;
  path: string | null;
  line: number | null;
  summary: string;
  expected: readonly CheckerId[];
};

export type PlanFactClaim = { rows: Array<{ item: number; evidence: string[] }> };

/** A candidate with one defect in it; `claim` is the writer's honest table, written against the diff before the defect. */
export type Planted = {
  defect: PlantedDefect;
  contract: TaskV2;
  changes: FileChange[];
  claim: PlanFactClaim;
};

export type Outcome = "hit" | "miss" | "off_target" | "n/a" | "error" | "skipped_budget";

export type CheckerResult = {
  checker: CheckerId;
  outcome: Outcome;
  /** The checker raised something (a failing command, an unowned path, a lint code, an unproven item, a non-pass verdict). */
  flagged: boolean;
  detail: string;
  tokens?: number;
  costUsd?: number | null;
  ms?: number;
};

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export const defectId = (taskId: string, defectClass: DefectClass): string => `${taskId}:${defectClass}`;
export const CONTROL = "control" as const;
export const controlId = (taskId: string): string => `${taskId}:${CONTROL}`;

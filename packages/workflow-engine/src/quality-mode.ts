import { QUALITY_MODES, type QualityMode } from "./schema";

/**
 * One order for a task's quality mode: contract, then the node's own mode, then the workflow (`fixed`, then `min`, then the
 * asked mode, then `default`), then the project. A contract or an explicit input of `full` inside a workflow whose mode is
 * `fixed: quick` is a conflict: it is not silently run as quick. `start({ mode: "full" })` on that workflow is still the
 * workflow's fixed mode (the caller did not name a contract).
 */
export type QualityPick =
  | { ok: true; mode: QualityMode; source: "contract" | "node" | "workflow" | "project" }
  | { ok: false; code: "quality_mode_conflict"; detail: string };

const asMode = (value: unknown): QualityMode | undefined =>
  (QUALITY_MODES as readonly unknown[]).includes(value) ? value as QualityMode : undefined;

export function resolveTaskQualityMode(input: {
  contract?: unknown;
  node?: unknown;
  /** The run's mode, or the mode named in the start input when `explicitAsk` is set. */
  asked?: unknown;
  /** The start input named `quality_mode` itself (not the inherited `$mode`). */
  explicitAsk?: boolean;
  workflow?: { default?: QualityMode; min?: QualityMode; fixed?: QualityMode } | null;
  project?: unknown;
}): QualityPick {
  const fixed = input.workflow?.fixed;
  const contractFull = input.contract === "full" || input.node === "full";
  if (fixed === "quick" && (contractFull || (input.explicitAsk === true && input.asked === "full"))) {
    return { ok: false, code: "quality_mode_conflict", detail: "quality_mode full conflicts with this workflow's fixed quick" };
  }
  const contract = asMode(input.contract);
  if (contract) return { ok: true, mode: contract, source: "contract" };
  const node = asMode(input.node);
  if (node) return { ok: true, mode: node, source: "node" };
  const asked = asMode(input.asked) ?? input.workflow?.default ?? asMode(input.project) ?? "standard";
  const floor = input.workflow?.min;
  const mode = fixed ?? (floor && QUALITY_MODES.indexOf(asked) < QUALITY_MODES.indexOf(floor) ? floor : asked);
  const fromWorkflow = Boolean(fixed || floor || input.workflow?.default || asMode(input.asked));
  return { ok: true, mode, source: fromWorkflow ? "workflow" : asMode(input.project) ? "project" : "workflow" };
}

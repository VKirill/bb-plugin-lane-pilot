import { EVOLVE_THRESHOLDS } from "@lane-pilot/contracts";
import { CRITIC_MAX_FALSE_ALARM } from "./score";

export const OUTPUT_DEFECT_KINDS = [
  "drop_required_field",
  "swap_number",
  "empty_artifact",
  "claim_done_without_artifact",
] as const;
export type OutputDefectKind = (typeof OUTPUT_DEFECT_KINDS)[number];

export type PlantOutputOptions = {
  /** Explicit required keys to target first for `drop_required_field`. */
  requiredFields?: readonly string[];
};

export type OutputVerifierCase =
  | Record<string, unknown>
  | { output: Record<string, unknown>; kinds?: readonly OutputDefectKind[] };

export type VerifierFn = (output: Record<string, unknown>) => boolean | { ok: boolean };

export type VerifierScore = {
  planted: number;
  caught: number;
  catchRate: number | null;
  controls: number;
  falseAlarms: number;
  falseAlarmRate: number | null;
  bar: number;
  passed: boolean;
};

const PRIMARY_ARTIFACT_KEYS = new Set([
  "artifact", "artifacts", "file", "files", "file_path", "filepath", "path", "pdf", "url", "patch", "diff",
]);
const SECONDARY_ARTIFACT_KEYS = new Set([
  "output", "content", "body", "text", "summary", "data", "result", "items",
]);
const STATUS_CLAIM_KEYS = new Set(["status", "state", "ok", "done", "accepted", "id", "taskid", "runid"]);
const DONE_STATUSES = new Set(["done", "sent", "ok", "succeeded", "completed"]);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isArtifactKey = (key: string, includeSecondary: boolean): boolean => {
  const lower = key.toLowerCase();
  if (PRIMARY_ARTIFACT_KEYS.has(lower)) return true;
  if (/_(path|file|artifact|url)$/.test(lower) || /(Path|File|Artifact|Url)$/.test(key)) return true;
  return includeSecondary && SECONDARY_ARTIFACT_KEYS.has(lower);
};

const middle = <T>(items: readonly T[]): T | undefined => items[Math.floor((items.length - 1) / 2)];
const ratio = (part: number, whole: number): number | null => (whole ? Math.round((1000 * part) / whole) / 1000 : null);

function isNonEmptyValue(value: unknown): boolean {
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return false;
}

function emptyValueOf(value: unknown): unknown {
  if (typeof value === "string") return "";
  if (Array.isArray(value)) return [];
  if (isPlainObject(value)) return {};
  return value;
}

type NumberSlot = { container: Record<string, unknown> | unknown[]; key: string | number; value: number };

function collectNumbers(node: unknown, out: NumberSlot[]): void {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const val = node[i];
      if (typeof val === "number" && Number.isFinite(val)) out.push({ container: node, key: i, value: val });
      else collectNumbers(val, out);
    }
    return;
  }
  if (!isPlainObject(node)) return;
  for (const key of Object.keys(node)) {
    const val = node[key];
    if (typeof val === "number" && Number.isFinite(val)) out.push({ container: node, key, value: val });
    else collectNumbers(val, out);
  }
}

function setSlot(slot: NumberSlot, next: number): void {
  if (Array.isArray(slot.container)) slot.container[slot.key as number] = next;
  else slot.container[slot.key as string] = next;
}

type FieldSlot = { container: Record<string, unknown>; key: string; value: unknown };

function collectFieldSlots(node: unknown, out: FieldSlot[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectFieldSlots(item, out);
    return;
  }
  if (!isPlainObject(node)) return;
  for (const key of Object.keys(node)) {
    const value = node[key];
    out.push({ container: node, key, value });
    collectFieldSlots(value, out);
  }
}

function dropRequiredField(clone: Record<string, unknown>, options?: PlantOutputOptions): boolean {
  const candidates = (options?.requiredFields?.length
    ? options.requiredFields.filter((key) => Object.hasOwn(clone, key) && clone[key] !== undefined)
    : Object.keys(clone).filter((key) => clone[key] !== undefined));
  const target = middle(candidates);
  if (!target) return false;
  delete clone[target];
  return true;
}

function swapNumber(clone: Record<string, unknown>): boolean {
  const slots: NumberSlot[] = [];
  collectNumbers(clone, slots);
  if (!slots.length) return false;
  if (slots.length >= 2) {
    const first = slots[0]!;
    const other = slots.find((slot) => slot.value !== first.value);
    if (other) {
      setSlot(first, other.value);
      setSlot(other, first.value);
      return true;
    }
  }
  const target = slots[0]!;
  setSlot(target, target.value === 0 ? 1 : target.value + 1);
  return true;
}

function emptyArtifact(clone: Record<string, unknown>): boolean {
  const slots: FieldSlot[] = [];
  collectFieldSlots(clone, slots);
  const primary = slots.find((slot) => isArtifactKey(slot.key, false) && isNonEmptyValue(slot.value));
  const secondary = primary ?? slots.find((slot) => isArtifactKey(slot.key, true) && isNonEmptyValue(slot.value));
  const fallback = secondary ?? slots.find((slot) => !STATUS_CLAIM_KEYS.has(slot.key.toLowerCase()) && isNonEmptyValue(slot.value));
  if (!fallback) return false;
  fallback.container[fallback.key] = emptyValueOf(fallback.value);
  return true;
}

function claimDoneWithoutArtifact(clone: Record<string, unknown>): boolean {
  const slots: FieldSlot[] = [];
  collectFieldSlots(clone, slots);
  for (const slot of slots) {
    if (isArtifactKey(slot.key, true)) delete slot.container[slot.key];
  }
  if (typeof clone.done === "boolean") clone.done = true;
  if (typeof clone.ok === "boolean") clone.ok = true;
  if (typeof clone.accepted === "boolean") clone.accepted = true;
  if ("status" in clone || (!("done" in clone) && !("ok" in clone) && !("accepted" in clone))) {
    const current = typeof clone.status === "string" ? clone.status.toLowerCase() : "";
    if (!DONE_STATUSES.has(current)) clone.status = "done";
  }
  return true;
}

/**
 * Deterministically plants one defect of `kind` into a structured workflow output without mutating the input.
 * Returns `null` when that defect kind cannot change the supplied output.
 */
export function plantOutputDefect(
  output: Record<string, unknown>,
  kind: OutputDefectKind,
  options?: PlantOutputOptions,
): Record<string, unknown> | null {
  if (!isPlainObject(output)) return null;
  const clone = structuredClone(output);
  let applied = false;
  switch (kind) {
    case "drop_required_field":
      applied = dropRequiredField(clone, options);
      break;
    case "swap_number":
      applied = swapNumber(clone);
      break;
    case "empty_artifact":
      applied = emptyArtifact(clone);
      break;
    case "claim_done_without_artifact":
      applied = claimDoneWithoutArtifact(clone);
      break;
  }
  if (!applied || JSON.stringify(clone) === JSON.stringify(output)) return null;
  return clone;
}

function runVerifier(verify: VerifierFn, output: Record<string, unknown>): boolean {
  try {
    const result = verify(output);
    return typeof result === "boolean" ? result : result.ok;
  } catch {
    return false;
  }
}

function isWrappedCase(
  entry: OutputVerifierCase,
): entry is { output: Record<string, unknown>; kinds: readonly OutputDefectKind[] } {
  return isPlainObject(entry) && isPlainObject(entry.output) && Array.isArray(entry.kinds);
}

/**
 * Evaluates a structured-output verifier against clean cases and planted defects.
 * Uses `EVOLVE_THRESHOLDS.checkerCatch` (0.9) as the catch-rate bar for evolve gates.
 */
export function scoreVerifier(
  verify: VerifierFn,
  cases: readonly OutputVerifierCase[],
  options?: PlantOutputOptions & { kinds?: readonly OutputDefectKind[] },
): VerifierScore {
  let controls = 0;
  let falseAlarms = 0;
  let planted = 0;
  let caught = 0;

  for (const entry of cases) {
    const wrapped = isWrappedCase(entry);
    const clean = wrapped ? entry.output : entry;
    const kinds = wrapped ? entry.kinds : (options?.kinds ?? OUTPUT_DEFECT_KINDS);

    controls++;
    if (!runVerifier(verify, clean)) falseAlarms++;

    for (const kind of kinds) {
      const defective = plantOutputDefect(clean, kind, options);
      if (!defective) continue;
      planted++;
      if (!runVerifier(verify, defective)) caught++;
    }
  }

  const catchRate = ratio(caught, planted);
  const falseAlarmRate = ratio(falseAlarms, controls);
  const passed = catchRate !== null
    && catchRate >= EVOLVE_THRESHOLDS.checkerCatch
    && (falseAlarmRate === null || falseAlarmRate <= CRITIC_MAX_FALSE_ALARM);

  return {
    planted,
    caught,
    catchRate,
    controls,
    falseAlarms,
    falseAlarmRate,
    bar: EVOLVE_THRESHOLDS.checkerCatch,
    passed,
  };
}

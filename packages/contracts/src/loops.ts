export const LOOP_NAMES = ["discovery", "branches", "evolve", "employee", "templates"] as const;
export type LoopName = (typeof LOOP_NAMES)[number];

export const LOOP_MODES = ["on", "report", "off"] as const;
export type LoopMode = (typeof LOOP_MODES)[number];

export type LoopModes = Record<LoopName, LoopMode>;

export type LoopHealthEntry = {
  loop: LoopName;
  mode: LoopMode;
  metric: number | null;
  threshold: number;
  failing: boolean;
  evidence: Record<string, unknown>;
};

export const DEFAULT_LOOP_MODES: LoopModes = {
  discovery: "on",
  branches: "on",
  evolve: "on",
  employee: "on",
  templates: "on",
};

/** M19 kill criteria per learning loop: when breached, the weekly review desk defaults to switching the loop to `report`. */
export const KILL_CRITERIA = {
  discovery: {
    minAcceptedOfLast: 1,
    lastDraftsWindow: 3,
    minRunsIn30Days: 3,
    postPublishDays: 30,
    staleDraftDays: 14,
  },
  branches: {
    minAcceptedOfLast: 1,
    lastDraftsWindow: 3,
    staleDraftDays: 14,
  },
  evolve: {
    windowWeeks: 4,
    minProposedWithoutWin: 3,
    minRollbacksIn30Days: 2,
    rollbackWindowDays: 30,
  },
  employee: {
    minConclusiveShare8w: 0.5,
    windowWeeks: 8,
  },
  templates: {
    minAcceptedOfLast: 1,
    lastDraftsWindow: 3,
    staleDraftDays: 14,
  },
} as const;

const LOOP_NAME_SET = new Set<string>(LOOP_NAMES);
const LOOP_MODE_SET = new Set<string>(LOOP_MODES);

function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Resolves a partial or JSON-encoded `loops.mode` setting onto the default `on` state for all loops. */
export function parseLoopModes(raw: unknown): LoopModes {
  const result: LoopModes = { ...DEFAULT_LOOP_MODES };
  const obj = parseJsonObject(raw);
  if (!obj) return result;
  for (const name of LOOP_NAMES) {
    const val = obj[name];
    if (typeof val === "string" && LOOP_MODE_SET.has(val)) {
      result[name] = val as LoopMode;
    }
  }
  return result;
}

/** Validates a `loops.mode` setting value; returns null when valid or empty. */
export function loopModesProblem(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const obj = parseJsonObject(value);
  if (!obj) return `object mapping ${LOOP_NAMES.join("|")} to ${LOOP_MODES.join("|")}`;
  for (const [key, entry] of Object.entries(obj)) {
    if (!LOOP_NAME_SET.has(key)) return `unknown loop "${key}" (expected ${LOOP_NAMES.join(", ")})`;
    if (typeof entry !== "string" || !LOOP_MODE_SET.has(entry)) {
      return `invalid mode for "${key}" (expected ${LOOP_MODES.join(", ")})`;
    }
  }
  return null;
}

/** Gate decisions for the `evolve` loop: `report` runs analysis without opening trials or publishing; `off` skips. */
export function evolveLoopAllows(mode: LoopMode): { run: boolean; openTrials: boolean; publish: boolean } {
  return {
    run: mode !== "off",
    openTrials: mode === "on",
    publish: mode === "on",
  };
}

/** Whether the `employee` loop must stay propose-only regardless of grants. */
export function employeeProposeOnly(mode: LoopMode): boolean {
  return mode !== "on";
}

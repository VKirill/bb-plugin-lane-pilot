import { defineSetting, type SettingDefinition } from "@lane-pilot/settings-catalog";

export const EVOLVE_ENABLED_KEY = "evolve.enabled";
export const EVOLVE_GRAPHS_KEY = "evolve.graphs";
export const EVOLVE_REPLAY_MAX_RUNS_KEY = "evolve.replay_max_runs";

export const EVOLVE_SETTING_KEYS = [EVOLVE_ENABLED_KEY, EVOLVE_GRAPHS_KEY, EVOLVE_REPLAY_MAX_RUNS_KEY] as const;

export type EvolveSettings = {
  enabled: boolean;
  graphs: string[];
  replayMaxRuns: number;
};

export const EVOLVE_DEFAULTS: EvolveSettings = {
  enabled: true,
  graphs: ["invoice-send"],
  replayMaxRuns: 120,
};

function parseBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "on" || value === "true" || value === "1" || value === 1) return true;
  if (value === "off" || value === "false" || value === "0" || value === 0) return false;
  return fallback;
}

function parsePositiveInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed) && parsed >= 1) return parsed;
  }
  return fallback;
}

function parseGraphs(value: unknown, fallback: readonly string[]): string[] {
  if (value === undefined || value === null || value === "") return [...fallback];
  let list: unknown = value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [...fallback];
    if (trimmed.startsWith("[")) {
      try {
        list = JSON.parse(trimmed);
      } catch {
        return [...fallback];
      }
    } else {
      return [...new Set(trimmed.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean))];
    }
  }
  if (!Array.isArray(list)) return [...fallback];
  return [...new Set(list.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))];
}

/** Parses `evolve.*` settings from merged settings. */
export function parseEvolveSettings(raw: Record<string, unknown>): EvolveSettings {
  return {
    enabled: parseBool(raw[EVOLVE_ENABLED_KEY], EVOLVE_DEFAULTS.enabled),
    graphs: parseGraphs(raw[EVOLVE_GRAPHS_KEY], EVOLVE_DEFAULTS.graphs),
    replayMaxRuns: parsePositiveInt(raw[EVOLVE_REPLAY_MAX_RUNS_KEY], EVOLVE_DEFAULTS.replayMaxRuns),
  };
}

/** Validates an `evolve.*` setting value; returns null when valid or empty. */
export function evolveSettingProblem(key: string, value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (key === EVOLVE_ENABLED_KEY) {
    if (typeof value === "boolean" || ["on", "off", "true", "false"].includes(String(value))) return null;
    return "true, false, on, off";
  }
  if (key === EVOLVE_GRAPHS_KEY) {
    let list: unknown = value;
    if (typeof value === "string") {
      try {
        list = JSON.parse(value);
      } catch {
        return "JSON array of workflow id strings";
      }
    }
    if (!Array.isArray(list) || !list.every((item) => typeof item === "string" && item.trim().length > 0)) {
      return "array of non-empty workflow id strings";
    }
    return null;
  }
  if (key === EVOLVE_REPLAY_MAX_RUNS_KEY) {
    const parsed = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
    if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 1) {
      return "integer >= 1";
    }
    return null;
  }
  return null;
}

export const evolveSettings: readonly SettingDefinition[] = [
  defineSetting({
    key: EVOLVE_ENABLED_KEY,
    room: "evolve",
    default: true,
    bounds: { kind: "boolean", options: ["true", "false"] },
    ui: {
      status: "hidden",
      control: "switch",
      section: "improvement",
      scope: "global",
      options: ["true", "false"],
      invType: "bool",
      reason: "Enable event-driven lp.evolve hypothesis generation and evolution loop",
    },
  }),
  defineSetting({
    key: EVOLVE_GRAPHS_KEY,
    room: "evolve",
    default: ["invoice-send"],
    defaultValue: JSON.stringify(["invoice-send"]),
    bounds: { kind: "json" },
    ui: {
      status: "hidden",
      control: "input",
      section: "improvement",
      scope: "global",
      reason: "Allow-listed workflow IDs eligible for lp.evolve",
    },
  }),
  defineSetting({
    key: EVOLVE_REPLAY_MAX_RUNS_KEY,
    room: "evolve",
    default: 120,
    bounds: { kind: "int", min: 1 },
    ui: {
      status: "hidden",
      control: "number",
      section: "improvement",
      scope: "global",
      min: 1,
      invType: "int",
      reason: "Maximum agent executions (cases * k * 3 arms) allowed per lp.evolve offline replay",
    },
  }),
];

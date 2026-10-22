/** Settings of the night loop, kept in the plugin key-value store (`wall:config`), changed with `bb lane-pilot wall config`. */
export type WallConfig = {
  enabled: boolean;
  /** At most this many classes get a repair in one night (Maslov: 1-3 recommendations per cycle). */
  maxClassesPerNight: number;
  /** A class gets at most this many repair rounds in one night. */
  roundsPerNight: number;
  /** Normal moves before the hunt (owner default 2: the third move is replaced by the hunt). */
  walks: number;
  /** Read-only hunters per wall. */
  hunters: number;
  /** The cap on everything one night spends (repair threads, hunters, analysis), in tokens. Recorded per night. */
  nightTokenCap: number;
  /** The share of the cap the hunts of one night may use. */
  huntShare: number;
  /** What a repair thread counts for before its real usage is synced (a thread that reports none keeps this). */
  assumedRepairTokens: number;
  /** The perspective of the hunters, the informed round and the analysis: another model than the repair engineer's. */
  hunterProviderId: string;
  hunterModel: string;
  hunterReasoningLevel: string;
  /** Tasks of the newest bench set the acceptance compares; 0 turns the bench check off (then nothing is merged alone). */
  benchSubset: number;
  /** Re-run failed attempts of a repaired class on sandbox and bench projects only; real projects go to the morning list. */
  rerunSandboxOnly: boolean;
  /** A class that is not on Lane Pilot's side qualifies when it happened this many times in 7 days. */
  recurrenceFloor: number;
};

export const WALL_DEFAULTS: WallConfig = {
  enabled: true,
  maxClassesPerNight: 3,
  roundsPerNight: 2,
  walks: 2,
  hunters: 3,
  nightTokenCap: 20_000_000,
  huntShare: 0.25,
  assumedRepairTokens: 4_000_000,
  hunterProviderId: "codex",
  hunterModel: "gpt-6.1-sol",
  hunterReasoningLevel: "medium",
  benchSubset: 8,
  rerunSandboxOnly: true,
  recurrenceFloor: 3,
};

export const WALL_CONFIG_KEY = "wall:config";

const count = (value: unknown, fallback: number, max = 1_000_000_000): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(max, Math.floor(value)) : fallback;

/** A stored value over the defaults; every field is checked, a bad one keeps its default. */
export function parseWallConfig(raw: unknown): WallConfig {
  const row = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const text = (value: unknown, fallback: string) => (typeof value === "string" && value.trim() ? value.trim() : fallback);
  const share = typeof row.huntShare === "number" && row.huntShare > 0 && row.huntShare <= 1 ? row.huntShare : WALL_DEFAULTS.huntShare;
  return {
    enabled: typeof row.enabled === "boolean" ? row.enabled : WALL_DEFAULTS.enabled,
    maxClassesPerNight: Math.max(1, count(row.maxClassesPerNight, WALL_DEFAULTS.maxClassesPerNight, 3)),
    roundsPerNight: Math.max(1, count(row.roundsPerNight, WALL_DEFAULTS.roundsPerNight, 2)),
    walks: Math.max(1, count(row.walks, WALL_DEFAULTS.walks, 5)),
    hunters: Math.max(1, count(row.hunters, WALL_DEFAULTS.hunters, 5)),
    nightTokenCap: count(row.nightTokenCap, WALL_DEFAULTS.nightTokenCap),
    huntShare: share,
    assumedRepairTokens: count(row.assumedRepairTokens, WALL_DEFAULTS.assumedRepairTokens),
    hunterProviderId: text(row.hunterProviderId, WALL_DEFAULTS.hunterProviderId),
    hunterModel: text(row.hunterModel, WALL_DEFAULTS.hunterModel),
    hunterReasoningLevel: text(row.hunterReasoningLevel, WALL_DEFAULTS.hunterReasoningLevel),
    benchSubset: count(row.benchSubset, WALL_DEFAULTS.benchSubset, 50),
    rerunSandboxOnly: row.rerunSandboxOnly === false ? false : true,
    recurrenceFloor: Math.max(1, count(row.recurrenceFloor, WALL_DEFAULTS.recurrenceFloor, 50)),
  };
}

export type UiStatus = "editable" | "readonly" | "hidden" | "gap" | "excluded";
export type ControlKind = "select" | "switch" | "input" | "number" | "slider" | "path";
export type ChannelKind = "OWN" | "NONE" | "INSTALL-ENV" | "ENV-PASSTHROUGH";
export type CliBinary = "run-controller" | "lane-ctl";

export const SECTION_ORDER = [
  "writer",
  "night-review",
  "browser-qa",
  "docs",
  "memory",
  "specialist",
  "onboard",
  "stages",
  "council",
  "workspace",
  "pm-read",
  "language",
  "setup",
  "ops",
  "guard",
  "limits",
  "gate",
  "files",
  "improvement",
  "other",
] as const;

export const WRITER_EFFORT_CHOICES_BY_PROVIDER: Record<string, string[]> = {
  agy: ["low", "medium", "high"],
  grok: ["low", "medium", "high"],
  qwen: ["low", "medium", "high"],
  kimi: ["low", "medium", "high"],
  codex: ["low", "medium", "high", "xhigh", "max"],
  cursor: ["low", "medium", "high"],
  opencode: ["low", "medium", "high"],
};

export const UNAPPLIED_REASON = {
  noChannel: "no upstream CLI flag or env channel; native Lane Pilot does not pass this setting",
  noConsumer: "no runtime consumer reads this setting",
  installNotCli: "consumed only by lane-pilot install env; not a per-run CLI argument",
  planCritiqueMode: "plan_critique.mode is native to the Lane Pilot critique stage",
  planCritiqueEnabled: "plan_critique.enabled is native to the Lane Pilot critique stage",
  planCritiqueProvider: "plan_critique.provider is validated against the live host catalog for native critique",
  planCritiqueModel: "plan_critique.model is validated against the live host catalog for native critique",
  nightReviewModel: "night_review.model is validated against the live host catalog for native review",
  nightReviewEffort: "night_review.reasoning_effort is validated against the selected provider/model",
  booleanOffUnsupported: "boolean flag cannot be turned off explicitly because upstream exposes only an enable flag",
  legacyFastModeMigrated: "writer.fast_mode is a read-only legacy setting; writer.service_tier carries the active choice",
} as const;

export type SettingSpec = {
  key: string;
  channel: ChannelKind | "W-DIRECT" | "OPS-DIRECT";
  binaries?: CliBinary[];
  subcommands?: string[];
  flag?: string;
  offFlag?: string;
  booleanFlag?: boolean;
  env?: string;
  reason?: string;
};

export function unappliedNotValidReason(spec: SettingSpec, binary: CliBinary, subcommand: string): string {
  return `${spec.channel} flag ${spec.flag ?? spec.env ?? spec.key} is not valid on ${binary} ${subcommand}`;
}

export type BoundKind =
  | "boolean"
  | "int"
  | "number"
  | "enum"
  | "string"
  | "path"
  | "json"
  | "provider_pool"
  | "role_model"
  | "errand_default"
  | "zcode_window"
  | "planning_home"
  | "lead"
  | "hub"
  | "cron"
  | "time_range"
  | "time_zone";

export type SettingBounds = {
  kind: BoundKind;
  min?: number;
  max?: number;
  zeroOff?: boolean;
  options?: readonly string[];
  /** When false, options act as UI/documentation hints (e.g. dynamic provider/model fields). */
  strictOptions?: boolean;
  maxLength?: number;
  absolutePath?: boolean;
  allowEmpty?: boolean;
};

export type SettingUiHint = {
  id?: string;
  status: "editable" | "readonly" | "hidden";
  control: ControlKind;
  section: string;
  scope: string;
  options?: readonly string[];
  min?: number | null;
  max?: number | null;
  invType?: string;
  channel?: ChannelKind;
  legacyName?: string;
  reason?: string;
};

export type SettingInput = {
  key: string;
  room: string;
  default: unknown;
  defaultValue?: string;
  bounds: SettingBounds;
  ui: SettingUiHint;
};

export type SettingDefinition = {
  readonly index?: number;
  readonly id: string;
  readonly key: string;
  readonly room: string;
  readonly default: unknown;
  readonly bounds: SettingBounds;
  readonly ui: SettingUiHint;
  // Unified catalog-compatible projections (single source of truth, zero duplicate tables).
  readonly storageKey: string;
  readonly setting: string;
  readonly defaultValue: string;
  readonly uiStatus: "editable" | "readonly" | "hidden";
  readonly control: ControlKind;
  readonly options: string[];
  readonly min: number | null;
  readonly max: number | null;
  readonly invType: string;
  readonly section: string;
  readonly scope: string;
  readonly channel: ChannelKind;
  readonly reason?: string;
};

/** @deprecated Compatibility alias for UI components migrating from the generated catalog. */
export type CatalogRow = SettingDefinition;

export function defineSetting(input: SettingInput): SettingDefinition {
  const id = input.ui.id ?? input.key.replace(/[^a-zA-Z0-9_]/g, "_");
  const defaultValue = input.defaultValue ?? (input.default === undefined || input.default === null ? "" : String(input.default));
  const options = [...(input.ui.options ?? input.bounds.options ?? [])];
  const min = input.ui.min !== undefined ? input.ui.min : (input.bounds.min ?? null);
  const max = input.ui.max !== undefined ? input.ui.max : (input.bounds.max ?? null);
  return Object.freeze({
    id,
    key: input.key,
    room: input.room,
    default: input.default,
    bounds: input.bounds,
    ui: input.ui,
    storageKey: input.key,
    setting: input.ui.legacyName ?? input.key,
    defaultValue,
    uiStatus: input.ui.status,
    control: input.ui.control,
    options,
    min,
    max,
    invType: input.ui.invType ?? input.bounds.kind,
    section: input.ui.section,
    scope: input.ui.scope,
    channel: input.ui.channel ?? "OWN",
    ...(input.ui.reason ? { reason: input.ui.reason } : {}),
  });
}

export type SettingKeyFamily = {
  readonly room: string;
  readonly prefix: string;
  readonly pattern: RegExp;
  readonly what: string;
};

export type RoomSettingsPart = {
  readonly room: string;
  readonly settings?: readonly SettingDefinition[];
  readonly keyFamilies?: readonly SettingKeyFamily[];
};

export type SettingSource = "project" | "global" | "default";

const BOOL_WORDS = new Set(["true", "false", "on", "off", "1", "0", "yes", "no"]);

export function boundProblem(def: SettingDefinition, value: unknown): string | null {
  if (value === undefined || value === null || value === "") {
    return def.bounds.allowEmpty === false ? "required value" : null;
  }
  const { bounds } = def;
  switch (bounds.kind) {
    case "boolean": {
      if (typeof value === "boolean") return null;
      if (typeof value === "string" && BOOL_WORDS.has(value.trim().toLowerCase())) return null;
      return "true, false, on, off";
    }
    case "int":
    case "number": {
      const parsed = typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value.trim()) : value;
      if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
        return bounds.kind === "int" ? `integer${bounds.min != null ? ` >= ${bounds.min}` : ""}` : "number";
      }
      if (bounds.kind === "int" && !Number.isSafeInteger(parsed)) {
        return `integer${bounds.min != null ? ` >= ${bounds.min}` : ""}`;
      }
      if (bounds.zeroOff && parsed === 0) return null;
      if (bounds.min !== undefined && parsed < bounds.min) {
        return bounds.max !== undefined ? `${bounds.min}-${bounds.max}` : `integer >= ${bounds.min}`;
      }
      if (bounds.max !== undefined && parsed > bounds.max) {
        return bounds.min !== undefined ? `${bounds.min}-${bounds.max}` : `<= ${bounds.max}`;
      }
      return null;
    }
    case "hub": {
      if (bounds.min !== undefined || bounds.max !== undefined) {
        const parsed = typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value.trim()) : value;
        if (typeof parsed !== "number" || !Number.isSafeInteger(parsed)) {
          return `integer${bounds.min != null ? ` >= ${bounds.min}` : ""}`;
        }
        if (bounds.zeroOff && parsed === 0) return null;
        if (bounds.min !== undefined && parsed < bounds.min) {
          return bounds.max !== undefined ? `${bounds.min}-${bounds.max}` : `integer >= ${bounds.min}`;
        }
        if (bounds.max !== undefined && parsed > bounds.max) {
          return bounds.min !== undefined ? `${bounds.min}-${bounds.max}` : `<= ${bounds.max}`;
        }
        return null;
      }
      const allowed = bounds.options ?? [];
      if (allowed.length) {
        if (typeof value === "string" && allowed.includes(value)) return null;
        if (typeof value === "boolean" && allowed.includes(String(value))) return null;
        return allowed.join(", ");
      }
      return null;
    }
    case "enum": {
      const allowed = bounds.options ?? [];
      if (!allowed.length || bounds.strictOptions === false) {
        return typeof value === "string" || typeof value === "boolean" ? null : "string";
      }
      if (typeof value === "string" && allowed.includes(value)) return null;
      if (typeof value === "boolean" && allowed.includes(String(value))) return null;
      return allowed.join(", ");
    }
    case "path": {
      if (typeof value !== "string") return "path string";
      const trimmed = value.trim();
      if (trimmed.includes("\0")) return "path without null bytes";
      if (trimmed.split("/").includes("..")) return "path without ..";
      if (bounds.absolutePath && !trimmed.startsWith("/")) return "absolute path";
      return null;
    }
    case "json": {
      if (typeof value === "object" && value !== null) return null;
      if (typeof value === "string") {
        try {
          const parsed: unknown = JSON.parse(value);
          return parsed !== null && typeof parsed === "object" ? null : "JSON object or array";
        } catch {
          return "valid JSON";
        }
      }
      return "JSON object or array";
    }
    case "cron": {
      if (typeof value !== "string") return "five cron fields";
      return value.trim().split(/\s+/).length === 5 ? null : "five cron fields (30 6,10,14,18 * * *)";
    }
    case "time_range": {
      return typeof value === "string" && /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/.test(value)
        ? null
        : "HH:MM-HH:MM (23:00-08:00)";
    }
    case "time_zone": {
      if (typeof value !== "string") return "IANA timezone";
      try {
        new Intl.DateTimeFormat("en-GB", { timeZone: value });
        return null;
      } catch {
        return "Europe/Madrid";
      }
    }
    case "string": {
      if (typeof value !== "string" && !Array.isArray(value)) return "string";
      if (typeof value === "string" && bounds.maxLength !== undefined && value.length > bounds.maxLength) {
        return `at most ${bounds.maxLength} characters`;
      }
      return null;
    }
    default:
      return null;
  }
}

export const LEGACY_SETTING_ALIASES: Readonly<Record<string, string>> = {
  "workspace.mode": "adoc.040",
  gate: "run.gate",
  language: "ui.language",
};

/** Stored keys intentionally kept on a deliberate legacy/runtime allowlist (no unknown-key warning). */
export const LEGACY_STORED_KEYS: ReadonlySet<string> = new Set([
  "adoc.041",
  "adoc.042",
  "writer.best_of",
  "writer.best_of.rounds",
  "writer.best_of.slot_cap",
  "writer.best_of.token_budget",
  "night_review.enabled",
  "night_review.auto_merge",
  "night_review.max_fix_tasks",
  "night_review.provider",
  "night_review.model",
  "night_review.agent",
  "night_review.reasoning_effort",
  "night_review.service_tier",
  "project_life.enabled",
  "project_life.model",
  "project_life.provider",
  "project_life.reasoning_effort",
  "project_life.service_tier",
  "docs.agent",
  "docs.hour",
  "docs.maintain",
  "docs.model",
  "docs.page_cap",
  "docs.provider",
  "docs.reasoning_effort",
  "docs.service_tier",
  "docs.since",
  "docs.gitnexus_refresh",
  "docs.review",
  "hostId",
  "pmWorkspacePath",
  "writerWorkspacePath",
  "pmProviderId",
  "pmModel",
  "writerProviderId",
  "writerModel",
  "install.lastReceipt",
  "install.lastSnapshotPath",
  "writer.lastResult",
  "writer.lastPatch",
  "writer.pick",
  "conveyor",
  "stats.epoch",
  "capability.documentary_gate",
  "curriculum.weekly",
  "harness.adopt_by",
]);

export const LEGACY_STORED_KEY_PREFIXES: readonly string[] = [
  "regress.",
  "import.",
  "install.last",
  "writer.last",
  "cli.last",
  "cli.receipt.",
  "protection.disarm.",
  "schedule.",
  "jev.",
  "council.",
  "ship.",
  "harness.",
];

export function isLegacyStoredKey(key: string): boolean {
  return LEGACY_STORED_KEYS.has(key) || LEGACY_STORED_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export type SettingsRegistry = {
  readonly all: readonly SettingDefinition[];
  readonly visible: readonly SettingDefinition[];
  readonly editable: readonly SettingDefinition[];
  readonly hidden: readonly SettingDefinition[];
  readonly byKey: ReadonlyMap<string, SettingDefinition>;
  readonly keyFamilies: readonly SettingKeyFamily[];
  get(key: string): SettingDefinition | undefined;
  isRegistered(key: string): boolean;
  read<T = unknown>(
    key: string,
    opts?: {
      project?: Record<string, unknown>;
      global?: Record<string, unknown>;
      runId?: string;
      debug?: (message: string) => void;
    },
  ): { value: T; source: SettingSource };
  warnUnknownKeys(storedKeys: Iterable<string>, warn: (message: string) => void): string[];
};

export function composeSettingsRegistry(parts: readonly RoomSettingsPart[]): SettingsRegistry {
  const byKey = new Map<string, SettingDefinition>();
  const keyFamilies: SettingKeyFamily[] = [];
  for (const part of parts) {
    for (const def of part.settings ?? []) {
      if (def.room !== part.room) {
        throw new Error(`setting ${def.key} declares room=${def.room} but was registered under ${part.room}`);
      }
      const prev = byKey.get(def.key);
      if (prev) {
        throw new Error(`duplicate setting key ${def.key} in rooms ${prev.room} and ${part.room}`);
      }
      byKey.set(def.key, def);
    }
    for (const family of part.keyFamilies ?? []) {
      keyFamilies.push(family);
    }
  }
  const all = Object.freeze([...byKey.values()].map((def, idx) => {
    const indexed = def.index === idx ? def : { ...def, index: idx };
    byKey.set(indexed.key, indexed);
    return indexed;
  }));
  const visible = Object.freeze(all.filter((row) => row.uiStatus !== "hidden"));
  const editable = Object.freeze(visible.filter((row) => row.uiStatus === "editable"));
  const hidden = Object.freeze(all.filter((row) => row.uiStatus === "hidden"));
  const readLogged = new Map<string, Set<string>>();
  const unknownWarned = new Set<string>();

  const isRegistered = (key: string): boolean => byKey.has(key) || keyFamilies.some((fam) => fam.pattern.test(key));

  return {
    all,
    visible,
    editable,
    hidden,
    byKey,
    keyFamilies: Object.freeze(keyFamilies),
    get: (key: string) => byKey.get(key) ?? byKey.get(LEGACY_SETTING_ALIASES[key] ?? ""),
    isRegistered,
    read<T = unknown>(
      key: string,
      opts?: {
        project?: Record<string, unknown>;
        global?: Record<string, unknown>;
        runId?: string;
        debug?: (message: string) => void;
      },
    ): { value: T; source: SettingSource } {
      const def = byKey.get(key);
      let source: SettingSource = "default";
      let value: unknown = def ? def.default : undefined;
      if (opts?.project && Object.hasOwn(opts.project, key) && opts.project[key] !== undefined) {
        source = "project";
        value = opts.project[key];
      } else if (opts?.global && Object.hasOwn(opts.global, key) && opts.global[key] !== undefined) {
        source = "global";
        value = opts.global[key];
      }
      if (opts?.debug) {
        const scopeId = opts.runId ?? "__default__";
        let seen = readLogged.get(scopeId);
        if (!seen) {
          seen = new Set();
          readLogged.set(scopeId, seen);
        }
        if (!seen.has(key)) {
          seen.add(key);
          opts.debug(`settings.read key=${key} source=${source}`);
        }
      }
      return { value: value as T, source };
    },
    warnUnknownKeys(storedKeys: Iterable<string>, warn: (message: string) => void): string[] {
      const unknown: string[] = [];
      for (const key of storedKeys) {
        if (isRegistered(key) || isLegacyStoredKey(key)) continue;
        unknown.push(key);
        if (!unknownWarned.has(key)) {
          unknownWarned.add(key);
          warn(`settings.unknown-key key=${key}`);
        }
      }
      return unknown;
    },
  };
}

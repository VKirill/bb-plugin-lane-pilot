// The settings a map node's reachability can depend on: every key the registry knows (the settings catalog, the UI
// catalog and the unlisted switches), its default, and the effective values on the hub — the global `*` rows over the
// defaults, and each active project's rows over those. sma-parity-tz.md §4.3: a node is reachable only under the
// settings the hub really runs, without a manual switch.
import { SETTING_CATALOG, UI_CATALOG } from "@lane-pilot/settings-catalog";
// A copy of the settings room's UNLISTED_SWITCHES (scripts/sma-settings-snapshot.ts): importing that room would close a
// cycle in the room graph (settings → schedule → … → wall → sma-map).
import UNLISTED from "./unlisted-switches.json";

const UNLISTED_SWITCHES = UNLISTED as unknown as Readonly<Record<string, readonly [values: string, what: string]>>;

/** The drill sandboxes (src/rooms/contracts/project-scope.ts DRILL_SANDBOX_PROJECT_IDS; tests/sma-reach.test.ts keeps
 * the two equal): their tasks are drills, not the owner's work, so their overrides never decide reachability. */
export const SMA_DRILL_PROJECTS: readonly string[] = ["proj_3tb652jpsi", "proj_ibu6v9g64j"];

/** Families of keys whose names are built (a role, a council seat, a fallback rank): known by their shape. */
const KEY_FAMILIES = [/^role_model\.[\w-]+$/, /^council\.[\w-]+\.(?:model|provider|reasoning_effort)$/, /^writer\.fallback\d+\.(?:model|provider|reasoning_effort)$/, /^jev\.[\w.]+$/];

export type SettingInfo = { key: string; default: string | undefined; switchLike: boolean; source: "catalog" | "ui" | "unlisted" };

const ON = new Set(["on", "true", "1", "yes", "enabled"]);
const OFF = new Set(["off", "false", "0", "no", "disabled"]);

/** A stored or default value as the word a need compares: JSON-decoded, booleans and on/off spellings folded. */
export function settingWord(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  let v: unknown = value;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { /* a bare word */ } }
  if (typeof v === "boolean") return v ? "on" : "off";
  if (typeof v === "number") return String(v);
  if (typeof v !== "string") return JSON.stringify(v);
  const word = v.trim().toLowerCase();
  return ON.has(word) ? "on" : OFF.has(word) ? "off" : word;
}

/** A catalog default as a word: "None (effectively on)" → on, "codex (lp-defaults.ts …)" → codex, "" → unset. */
function catalogDefault(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const effectively = /effectively\s+(on|off)/i.exec(raw)?.[1];
  if (effectively) return effectively.toLowerCase();
  const head = raw.replace(/\s*\(.*$/s, "").trim();
  if (!head || /^none$/i.test(head) || head === "—") return undefined;
  return settingWord(head);
}

/** An unlisted switch's default as its description says it ("unset: on", "ON when unset"), else unset. */
function unlistedDefault(values: string, what: string): string | undefined {
  const said = /\bunset\b[^)]*?:\s*(on|off|gate|hold|warn|sensitive|\d+)/i.exec(what)?.[1] ?? (/\bON when unset\b/.test(what) ? "on" : undefined);
  if (said) return settingWord(said);
  return values === "on|off" ? "off" : undefined;
}

let registry: Map<string, SettingInfo> | null = null;

/** Every key the registry knows, with its default; the UI catalog's editable row wins over its other rows. */
export function settingRegistry(): ReadonlyMap<string, SettingInfo> {
  if (registry) return registry;
  const map = new Map<string, SettingInfo>();
  const live = new Map<string, (typeof UI_CATALOG)[number]>();
  for (const row of UI_CATALOG) { const cur = live.get(row.storageKey); if (!cur || (cur.uiStatus !== "editable" && row.uiStatus === "editable")) live.set(row.storageKey, row); }
  for (const [key, row] of live) {
    const switchLike = row.control === "switch" || (row.options.length === 2 && row.options.every((option) => ON.has(option.toLowerCase()) || OFF.has(option.toLowerCase())));
    map.set(key, { key, default: catalogDefault(row.defaultValue), switchLike, source: "ui" });
  }
  for (const spec of SETTING_CATALOG) if (!map.has(spec.key)) map.set(spec.key, { key: spec.key, default: undefined, switchLike: !!spec.booleanFlag, source: "catalog" });
  for (const [key, [values, what]] of Object.entries(UNLISTED_SWITCHES)) {
    map.set(key, { key, default: unlistedDefault(values, what), switchLike: /^on\|off$|^gate\|off$|^strict\|off$|^hold\|observe$|^refuse\|warn$/.test(values), source: "unlisted" });
  }
  registry = map;
  return map;
}

export const knownSettingKey = (key: string): boolean => settingRegistry().has(key) || KEY_FAMILIES.some((re) => re.test(key));

/** Effective settings: a word per key; a missing key is unset. */
export type EffectiveSettings = ReadonlyMap<string, string | undefined>;

/** The registry defaults alone (a source checkout without a database). */
export function defaultSettings(): EffectiveSettings {
  return new Map([...settingRegistry().values()].map((info) => [info.key, info.default] as const));
}

/** `base` with `rows` laid over it (stored values are JSON text). */
export function overlay(base: EffectiveSettings, rows: ReadonlyArray<{ key: string; value: unknown }>): EffectiveSettings {
  const out = new Map(base);
  for (const row of rows) out.set(row.key, settingWord(row.value));
  return out;
}

type Db = { prepare(sql: string): { all(...args: unknown[]): unknown[] } };
const SETTINGS_TABLE = "lane_pilot_project_settings";
const TASKS = "lane_pilot_task", RUNS = "lane_pilot_run";

export type HubSettings = { global: EffectiveSettings; globalRows: number; projects: Array<{ projectId: string; tasks: number; overrides: number; settings: EffectiveSettings }> };

/** The hub's effective settings: defaults, then the `*` rows; and per active project (tasks in the window, drill
 * sandboxes left out) its own rows over that. */
export function hubSettings(db: Db, since: number): HubSettings {
  const rows = db.prepare(`SELECT project_id AS projectId, key, value FROM ${SETTINGS_TABLE}`).all() as Array<{ projectId: string; key: string; value: string }>;
  const globalRows = rows.filter((row) => row.projectId === "*");
  const global = overlay(defaultSettings(), globalRows);
  const active = db.prepare(`SELECT r.project_id AS projectId, COUNT(*) AS tasks FROM ${TASKS} t JOIN ${RUNS} r ON r.id = t.run_id WHERE t.created_at >= ${Math.floor(since)} GROUP BY r.project_id ORDER BY tasks DESC`).all() as Array<{ projectId: string; tasks: number }>;
  const projects = active.filter((row) => row.projectId && !SMA_DRILL_PROJECTS.includes(row.projectId)).map((row) => {
    const own = rows.filter((setting) => setting.projectId === row.projectId);
    return { projectId: row.projectId, tasks: row.tasks, overrides: own.length, settings: overlay(global, own) };
  });
  return { global, globalRows: globalRows.length, projects };
}

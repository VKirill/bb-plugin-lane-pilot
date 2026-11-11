import { PROBE_DEFAULTS, type ProbeBudget } from "@lane-pilot/harness-core";
import { type ServerCore } from "../../contracts/server";
import { hubFields } from "../../platform/server";
import { TRIAL_DEFAULTS, type AdoptBy, type TrialConfig } from "./trial";

/**
 * The writer harness that learns (the Harness² port, phases 1–5). Per (project, area, writer model) one tree is active:
 * the base (empty) or an adopted one. At night an editor thread reads the area's recent attempts and proposes a
 * candidate tree; the candidate goes on trial on the area's next tasks in alternation with the active tree; the trial
 * adopts or retires it on the attempts' own outcomes; a reflection thread then writes what each edit did and at most
 * one lesson, which enters the rules pipeline with its form. Nothing a writer gets today is taken away: the tree adds.
 */
export type HarnessConfig = {
  enabled: boolean;
  /** Attempts a key needs in the window before an editor is spent on it. */
  minAttempts: number;
  windowDays: number;
  /** Keys one night may start an editor for, per project; an editor is three Opus sessions. */
  maxKeysPerNight: number;
  /** Attempts the editor reads, newest first. */
  attemptsPerEvidence: number;
  editor: ModelSelection;
  /** A role's own model when it differs from `editor`: the two editors, the composer and the reflection can spread the spend. */
  roles: Partial<Record<HarnessRole, ModelSelection | null>>;
  waitMinutes: number;
  trial: TrialConfig;
  /** `harness.adopt_by` (SMA plan P0-1): `bench` (default) adopts a tree only after a passed bench comparison; `live` keeps the alternation as the judge. */
  adoptBy: AdoptBy;
  /** Propose–Probe–Compose: saved attempts replayed before the composer, and the token cap for that round. `tokenBudget` 0 skips it. */
  probe: ProbeBudget;
  /** When true, an editor may change workflows/<name>.json. The file still goes through the same trial and bench gate. Off by default. */
  graphEdits: boolean;
  /** An area is taught only when its attempts in the window span at least this many days (≥5 attempts in one afternoon repeat nothing). */
  minSpanDays: number;
};

export type ModelSelection = { providerId: string; model: string; reasoningLevel: string };
export type HarnessRole = "inv" | "dom" | "compose" | "reflect";
export const HARNESS_ROLES: readonly HarnessRole[] = ["inv", "dom", "compose", "reflect"];

/** The model a role runs on: its own selection when complete, else the editor's. */
export function roleSelection(cfg: Pick<HarnessConfig, "editor" | "roles">, role: HarnessRole): ModelSelection {
  const own = cfg.roles?.[role];
  return own && own.providerId && own.model ? { ...own, reasoningLevel: own.reasoningLevel || cfg.editor.reasoningLevel } : cfg.editor;
}

export const HARNESS_DEFAULTS: HarnessConfig = {
  enabled: true, minAttempts: 5, windowDays: 7, maxKeysPerNight: 2, attemptsPerEvidence: 8,
  // Owner's choice 2026-10-19: the editors run on Gemini 3.8 Flash (high) through OpenCode's Antigravity route
  // (`router9/ag/gemini-3.8-flash-high`; the «high» is in the name, the effort stays the catalog default «medium»),
  // not on Opus: three sessions a key a night must stay cheap, and the trial, not the editor, decides what ships.
  editor: { providerId: "opencode2", model: "router9/ag/gemini-3.8-flash-high", reasoningLevel: "medium" }, roles: {}, waitMinutes: 40, trial: TRIAL_DEFAULTS, adoptBy: "bench", minSpanDays: 3,
  probe: PROBE_DEFAULTS, graphEdits: false,
};

export const CONFIG_KEY = (projectId: string) => `harness:config:${projectId}`;
export const LAST_EDIT_KEY = (projectId: string, area: string, writerKey: string) => `harness:last-edit:${projectId}:${area}:${writerKey}`;

/** The project's harness config: the defaults, the hub's `adopt_by`, and the project's stored patch; `setConfig` merges a patch a level deep. */
export function createConfig(ctx: ServerCore) {
  const { bb, db } = ctx;

  async function config(projectId: string): Promise<HarnessConfig> {
    const raw = await bb.storage.kv.get(CONFIG_KEY(projectId)) as Partial<HarnessConfig> | null;
    // `harness.adopt_by` of the global level is the default of every project; a project's own record still wins.
    const hub = hubFields(db, "harness") as { adoptBy?: AdoptBy };
    return { ...HARNESS_DEFAULTS, ...(hub.adoptBy ? { adoptBy: hub.adoptBy } : {}), ...(raw ?? {}), editor: { ...HARNESS_DEFAULTS.editor, ...(raw?.editor ?? {}) }, roles: { ...(raw?.roles ?? {}) }, trial: { ...TRIAL_DEFAULTS, ...(raw?.trial ?? {}) }, probe: { ...PROBE_DEFAULTS, ...(raw?.probe ?? {}) } };
  }

  /** A patch merges a level deep; a role set to null goes back to the editor's model. */
  async function setConfig(projectId: string, patch: Partial<HarnessConfig>): Promise<HarnessConfig> {
    const current = await config(projectId);
    const roles = { ...current.roles };
    for (const [role, value] of Object.entries(patch.roles ?? {})) {
      if (!HARNESS_ROLES.includes(role as HarnessRole)) continue;
      if (value === null) delete roles[role as HarnessRole]; else roles[role as HarnessRole] = { ...(roles[role as HarnessRole] ?? current.editor), ...value };
    }
    const next: HarnessConfig = { ...current, ...patch, editor: { ...current.editor, ...(patch.editor ?? {}) }, roles, trial: { ...current.trial, ...(patch.trial ?? {}) }, probe: { ...current.probe, ...(patch.probe ?? {}) } };
    // The resolved default stays out of the project's record unless the project set it, so a later change of the global default reaches it.
    const stored = await bb.storage.kv.get(CONFIG_KEY(projectId)) as Partial<HarnessConfig> | null;
    const keepAdopt = patch.adoptBy !== undefined || stored?.adoptBy !== undefined;
    const { adoptBy: _resolved, ...withoutAdopt } = next;
    await bb.storage.kv.set(CONFIG_KEY(projectId), (keepAdopt ? next : withoutAdopt) as never);
    return next;
  }

  return { config, setConfig };
}

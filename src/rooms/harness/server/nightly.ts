import { orMiss, isNotFound } from "@lane-pilot/kit";
import { inventory } from "@lane-pilot/harness-core";
import { type ServerCore } from "../../contracts/server";
import { SANDBOX_PROJECT_ID, isSandboxProjectName } from "../../contracts";
import { listActiveProjectIds } from "../../storage";
import { listHarnesses, teachingKeys, trialAttempts, trialHarness } from "./store";
import { decideTrial } from "./trial";
import { LAST_EDIT_KEY, HARNESS_ROLES, roleSelection, type HarnessConfig, type HarnessRole, type ModelSelection } from "./config";
import type { createEdit } from "./edit";
import type { createReflect } from "./reflect";

type Deps = {
  config: (projectId: string) => Promise<HarnessConfig>;
  evaluateTrials: ReturnType<typeof createReflect>["evaluateTrials"];
  benchInput: ReturnType<typeof createReflect>["benchInput"];
  runEditor: ReturnType<typeof createEdit>["runEditor"];
  running: Set<string>;
};

/** The nightly pass: which projects get taught, `tick` (judge the trials, then start the editors), and `status` for the UI. */
export function createNightly(ctx: ServerCore, deps: Deps) {
  const { bb, db } = ctx;
  const { config, evaluateTrials, benchInput, runEditor, running } = deps;

  async function teachingProjects(since: number): Promise<string[]> {
    const ids = listActiveProjectIds(db, since);
    const kept: string[] = [];
    for (const projectId of ids) {
      if (projectId === SANDBOX_PROJECT_ID) continue;
      const project = await orMiss(bb.sdk.projects.get({ projectId }), null, isNotFound) as { name?: string } | null;
      if (isSandboxProjectName(project?.name)) continue;
      kept.push(projectId);
    }
    return kept;
  }

  /** One night's work for a project: judge the trials, then start editors for the keys with enough new attempts. */
  async function tick(projectId: string, options: { dryRun?: boolean; night?: string } = {}): Promise<{ trials: Awaited<ReturnType<typeof evaluateTrials>>; editors: Array<{ area: string; writerKey: string; attempts: number; result: string }> }> {
    const cfg = await config(projectId);
    const trials = await evaluateTrials(projectId, { dryRun: options.dryRun });
    const editors: Array<{ area: string; writerKey: string; attempts: number; result: string }> = [];
    if (!cfg.enabled) return { trials, editors };
    const since = Date.now() - cfg.windowDays * 86_400_000;
    let started = 0;
    for (const key of teachingKeys(db, projectId, since, cfg.minAttempts, cfg.minSpanDays * 86_400_000)) {
      if (started >= cfg.maxKeysPerNight || ctx.isDisposed()) break;
      if (trialHarness(db, projectId, key.area, key.writerKey)) { editors.push({ ...key, result: "trial running" }); continue; }
      const last = await bb.storage.kv.get(LAST_EDIT_KEY(projectId, key.area, key.writerKey)) as { at?: number } | null;
      if (last?.at && Date.now() - last.at < cfg.windowDays * 86_400_000) { editors.push({ ...key, result: "edited recently" }); continue; }
      if (options.dryRun) { editors.push({ ...key, result: "would start an editor" }); started++; continue; }
      const result = await runEditor({ projectId, area: key.area, writerKey: key.writerKey, ...(options.night ? { night: options.night } : {}), reason: `nightly:${key.attempts} attempts in ${cfg.windowDays} days` });
      editors.push({ ...key, result: `${result.status}: ${result.detail}` });
      started++;
    }
    return { trials, editors };
  }

  async function status(projectId: string) {
    const cfg = await config(projectId);
    const trees = listHarnesses(db, projectId, { states: ["base", "adopted", "trial"] });
    const trials = trees.filter((row) => row.state === "trial").map((row) => ({ id: row.id, area: row.area, writerKey: row.writerKey, since: row.trialStartedAt, decision: decideTrial(trialAttempts(db, row), row.trialStartedAt ?? row.createdAt, Date.now(), cfg.trial, benchInput(cfg, row.id)) }));
    const recent = listHarnesses(db, projectId, { states: ["retired"] }).slice(0, 10).map((row) => ({ id: row.id, area: row.area, writerKey: row.writerKey, reason: row.reason, decidedAt: row.decidedAt }));
    return {
      config: cfg,
      roleModels: Object.fromEntries(HARNESS_ROLES.map((role) => [role, roleSelection(cfg, role)])) as Record<HarnessRole, ModelSelection>,
      keys: teachingKeys(db, projectId, Date.now() - cfg.windowDays * 86_400_000, 1),
      active: trees.filter((row) => row.state !== "trial").map((row) => ({ id: row.id, area: row.area, writerKey: row.writerKey, state: row.state, version: row.version, inventory: inventory(row.tree), tree: row.tree })),
      trials, retired: recent,
      running: [...running],
    };
  }

  return { teachingProjects, tick, status };
}

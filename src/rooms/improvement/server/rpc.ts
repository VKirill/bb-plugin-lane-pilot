import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import type { rpcContract } from "../../contracts";
import type { LanePilotDatabase } from "../../storage";
import { getSettingVersions } from "../../storage";
import { collectOwnerWaiting } from "../../owner-waiting";
import { loadPushConfig } from "../../owner-waiting/server";
import { EXAM_RESULT_KEY, POLICY, TIERS, loadLiveExam, runLiveExam, type StoredExam } from "../../policy";
import type { WallApi } from "../../wall/server";
import type { BenchApi } from "../../bench/server";
import type { DeferralApi } from "../../deferral/server";
import { readHubRows } from "../hub";
import { HUB_SPECS, PROJECT_DEFAULT_KEYS, settingValue } from "../keys";

/** The checks and defaults that are project-level settings read at the global level here (the page edits the default every project starts from). */
export const IMPROVEMENT_PROJECT_KEYS = [...PROJECT_DEFAULT_KEYS, "plan_fact.mode", "critic.code.default_for_risk", "memory.note_budget"] as const;

/** When the night loop runs by itself: `scheduleIsolated(bb, "wall-night", "0 3 * * *")` in src/rooms/wall/server/wall.ts. */
export const NIGHT_HOUR = 3;

/** The next time the clock of the machine the plugin runs on shows the night hour. */
export function nextNightRun(now: number): number {
  const next = new Date(now);
  next.setHours(NIGHT_HOUR, 0, 0, 0);
  if (next.getTime() <= now) next.setDate(next.getDate() + 1);
  return next.getTime();
}

type Kv = { get(key: string): Promise<unknown> };
export type ImprovementDeps = {
  db: LanePilotDatabase;
  kv: Kv;
  wall: Pick<WallApi, "config" | "status">;
  bench: Pick<BenchApi, "status" | "settings">;
  deferrals: Pick<DeferralApi, "list">;
  now?: () => number;
};

/** One read for the whole «Self-improvement» screen: the values of its controls, their versions, and the status strip and read-only blocks. */
export function improvementRpc(deps: ImprovementDeps) {
  const { db, kv } = deps;
  return {
    improvement_view: async () => {
      const now = (deps.now ?? Date.now)();
      const values: Record<string, unknown> = {};

      // The controls of the hub level: the effective value, the old store included.
      const wallConfig = await deps.wall.config();
      const benchSettings = await deps.bench.settings();
      const push = loadPushConfig(db);
      const hubRows = readHubRows(db);
      const effective: Record<string, Record<string, unknown>> = { wall: wallConfig as never, bench: benchSettings as never, owner_push: push as never, harness: { adoptBy: hubRows.get("harness.adopt_by")?.value ?? "bench" } };
      for (const spec of HUB_SPECS) values[spec.key] = settingValue(spec, effective[spec.area]?.[spec.field]);

      // The project-level defaults: what the global level holds, null when nothing is set (the field then shows the catalog default).
      const projectRows = readHubRows(db, IMPROVEMENT_PROJECT_KEYS);
      for (const key of IMPROVEMENT_PROJECT_KEYS) values[key] = projectRows.get(key)?.value ?? null;
      const versions = getSettingVersions(db, GLOBAL_SETTINGS_PROJECT_ID, [...HUB_SPECS.map((spec) => spec.key), ...IMPROVEMENT_PROJECT_KEYS], "");

      const wall = deps.wall.status();
      const lastNight = wall.nights[0] ?? null;
      const sets = deps.bench.status().slice().sort((a, b) => b.createdAt - a.createdAt);
      const set = sets[0] ?? null;

      const exam = runLiveExam(POLICY, await loadLiveExam(kv as never));
      const stored = (await kv.get(EXAM_RESULT_KEY).catch(() => null)) as StoredExam | null;
      const waiting = collectOwnerWaiting(db, now);
      const deferrals = deps.deferrals.list({});

      return {
        generatedAt: now,
        values,
        versions,
        status: {
          night: {
            enabled: wallConfig.enabled,
            hour: NIGHT_HOUR,
            lastRunAt: lastNight?.startedAt ?? null,
            lastDryRun: lastNight?.dryRun ?? false,
            lastSpend: lastNight?.spend ?? null,
            lastCap: lastNight?.cap ?? null,
            nextRunAt: wallConfig.enabled ? nextNightRun(now) : null,
            openClasses: wall.open,
          },
          bench: set ? { version: set.version, tasks: set.tasks, candidates: set.candidates, createdAt: set.createdAt, sets: sets.length } : null,
          policy: { version: POLICY.version, frozenAt: POLICY.frozen_at, unseen: exam.total, needed: exam.needed, enough: exam.enough, passed: exam.passed },
          waiting: { total: waiting.items.length, wake: waiting.items.filter((item) => item.wake).length },
        },
        policy: {
          version: POLICY.version,
          frozenAt: POLICY.frozen_at,
          minAccuracy: POLICY.exam.min_accuracy,
          verdict: exam.verdict,
          accuracy: exam.total ? exam.accuracy : null,
          inSplit: exam.inSplit,
          seenExcluded: exam.seenExcluded,
          lastRun: stored ? { at: stored.at, correct: stored.correct, total: stored.total, passed: stored.passed } : null,
          tiers: TIERS.map((tier) => ({ tier, entries: POLICY[tier].map((entry) => ({ id: entry.id, description: entry.description })) })),
          prohibitions: POLICY.standing_prohibitions.map((entry) => ({ id: entry.id, description: entry.description })),
        },
        deferrals: { open: deferrals.counts.open ?? 0, overdue: deferrals.overdue.length, needsTerm: deferrals.needsOwnerTerm.length },
      };
    },
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "improvement_view">;
}

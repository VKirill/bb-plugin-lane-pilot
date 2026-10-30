import { scheduleIsolated, type ServerCore } from "../../core/server";
import { loadProjectSettings, saveProjectSetting } from "../../storage";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { SERVICE_JOBS, servicePair, servicePinKey } from "../../workflow";
import type { BenchApi } from "../service";

/** What the monthly recheck needs of the bench: one series per arm, then the paired compare. */
export type ServiceRecheckBench = {
  status(): Array<{ version: string; createdAt: number }>;
  run(input: { version: string; arm: string; wait?: boolean; writer?: { providerId: string; model: string } }): Promise<unknown>;
  compare(input: { version: string; armA: string; armB: string }): { comparison: { verdict: "pass" | "fail" | "inconclusive" } };
};

export type ServiceRecheckRow = { id: string; action: "kept" | "rolled-back" | "code" | "skipped" };

const monthOf = (now: number): string => new Date(now).toISOString().slice(0, 7);

/**
 * Runs the newest bench set on the cheap model and on the previous one. A fail (the cheap arm is worse) writes
 * `service_model.<id> = "previous"`, which is the rollback. A code job is not a model. No set, or an inconclusive
 * compare, leaves the pin where it is.
 */
export async function recheckServiceModels(input: {
  bench: ServiceRecheckBench;
  now?: number;
  writePin: (key: string, value: "previous") => void;
}): Promise<ServiceRecheckRow[]> {
  const now = input.now ?? Date.now();
  const newest = input.bench.status().slice().filter((set) => !(set as { sealed?: boolean }).sealed).sort((a, b) => b.createdAt - a.createdAt)[0];
  const rows: ServiceRecheckRow[] = [];
  for (const job of SERVICE_JOBS) {
    if (!job.role || !job.previousRole) { rows.push({ id: job.id, action: "code" }); continue; }
    if (!newest) { rows.push({ id: job.id, action: "skipped" }); continue; }
    rows.push({ id: job.id, action: await recheckOne(input.bench, job, newest.version, now, input.writePin) });
  }
  return rows;
}

async function recheckOne(bench: ServiceRecheckBench, job: (typeof SERVICE_JOBS)[number], version: string, now: number, writePin: (key: string, value: "previous") => void): Promise<ServiceRecheckRow["action"]> {
  const month = monthOf(now);
  const previous = `svc-${job.id}-prev-${month}`;
  const cheap = `svc-${job.id}-cheap-${month}`;
  await bench.run({ version, arm: previous, wait: true, writer: servicePair(job.previousRole!) });
  await bench.run({ version, arm: cheap, wait: true, writer: servicePair(job.role!) });
  const result = bench.compare({ version, armA: previous, armB: cheap });
  if (result.comparison.verdict !== "fail") return "kept";
  writePin(servicePinKey(job.id), "previous");
  return "rolled-back";
}

/** First day of the month, 04:00 UTC. `bench.service_models = off` stops it. Two arms, so the cap is the night bench's. */
export function mountServiceModelRecheck(ctx: ServerCore, bench: () => BenchApi): void {
  scheduleIsolated(ctx.bb, "bench-service-models", "0 4 1 * *", async (signal) => {
    if (ctx.isDisposed() || signal?.aborted) return;
    const settings = loadProjectSettings(ctx.db, GLOBAL_SETTINGS_PROJECT_ID);
    if (String(settings["bench.service_models"] ?? "on") === "off") return;
    const rows = await recheckServiceModels({
      bench: bench(), writePin: (key, value) => saveProjectSetting(ctx.db, GLOBAL_SETTINGS_PROJECT_ID, key, value),
    });
    for (const row of rows) ctx.log(`bench-service-models: ${row.id} ${row.action}`);
  }, { timeoutMs: 8 * 3_600_000 });
}

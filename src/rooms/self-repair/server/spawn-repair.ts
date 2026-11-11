import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { stringAt } from "@lane-pilot/kit";
import { writerExecutionSelection } from "@lane-pilot/models";
import { projectRoleField } from "../../runs/server";
import type { LanePilotDatabase } from "../../storage";
import type { ServerCore } from "../../contracts/server";
import type { RepairDeps } from "./deps";
import { lastPmOwnerMessageAt } from "./episodes";
import type { NightAssignment } from "./hooks";
import { repairPrompt } from "./repair-prompt";
import type { Incident, PmLastOwnerAt, RepairWorktree, SelfRepairConfig } from "./types";

/** How long a worktree waits for a spawn of unknown outcome to settle before it is released. */
export const PENDING_MS = 30 * 60_000;

export type SpawnRepairArgs = { signature: string; samples: Incident[]; worktree: RepairWorktree; cfg: SelfRepairConfig; spawnId: string; now: number;
  night?: Pick<NightAssignment, "brief" | "selection"> | null; step?: { runId: string; stepKey: string; nodeId: string } };

export function createRepairSpawner(env: { bb: BbPluginApi; db: LanePilotDatabase; ctx: ServerCore; deps: RepairDeps }) {
  const { bb, db, ctx, deps } = env;
  const { fullAccessSpawn, graphStepMetadata, modelCatalogOf, resolveSpawnModel } = deps;

  /** The repair thread itself, started in the repair's worktree; the same call serves the direct spawn and the `repair` step of the graph. */
  async function spawnRepairThread(args: SpawnRepairArgs): Promise<string | null> {
    const { signature, samples, worktree, cfg, spawnId, now, night } = args;
    const pmIds = [...new Set(samples.map((sample) => sample.pmThreadId).filter((id): id is string => Boolean(id)))];
    const lastOwnerAt: PmLastOwnerAt = {};
    for (const id of pmIds) {
      lastOwnerAt[id] = await lastPmOwnerMessageAt((query) => bb.sdk.threads.events.list(query), id);
    }
    // The repair engineer's model (the night plan's pick, else the watcher's config, which already holds the `repairer` row of the table) goes
    // through the one resolver as a pin, so provider and model are a pair that can exist; the owner's pick is kept as it is.
    const picked = { providerId: night?.selection?.providerId ?? cfg.providerId, model: night?.selection?.model ?? cfg.model, reasoningLevel: night?.selection?.reasoningLevel ?? cfg.reasoningLevel };
    const repairer = resolveSpawnModel({ role: "repairer", settings: {}, catalog: modelCatalogOf(ctx).peek(), hostId: worktree.hostId, pinned: { provider: picked.providerId, model: picked.model, reasoning: picked.reasoningLevel } });
    const result = await fullAccessSpawn(bb, {
      projectId: cfg.projectId,
      environment: { type: "host", hostId: worktree.hostId, workspace: { type: "unmanaged", path: worktree.path } },
      title: `Lane Pilot self-repair: ${signature.split(":").slice(2).join(":").slice(0, 70)}`,
      prompt: repairPrompt(samples, signature, worktree, cfg, { now, lastOwnerAt, ...(night ? { brief: night.brief } : {}) }),
      ...writerExecutionSelection(repairer.providerId, repairer.model, repairer.reasoningEffort, "default"),
      // The code-repair profile (writer skills, gitnexus): without it the repair carried every plugin's instructions and the whole skill list.
      ...projectRoleField(bb, db, cfg.projectId, repairer.providerId, "code-repair"),
      pluginMetadata: { role: "self-repair", signature, spawnId, repairBranch: worktree.branch, ...graphStepMetadata(args.step) },
    } as Parameters<typeof fullAccessSpawn>[1]);
    return stringAt(result, "id");
  }

  return spawnRepairThread;
}

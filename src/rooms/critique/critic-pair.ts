import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { getReasoningTrace, listAttemptsForTask, type LanePilotDatabase } from "../storage";
import { bbServiceTier, findModelIn, judgeAgainstAuthor, modelFamily, peerOffSpent, resolveRoleModel, SAME_FAMILY_JUDGE_BY_LIMIT, type RoleModelSource, type SpentProbe } from "@lane-pilot/models";

/**
 * G9: the code critic is another model than the writer. Reviewing the writer's own work with the writer's own model
 * shares its blind spots, so when the critic's pair equals the writer's, the next usable pair is taken from the project's
 * stage selections and then the PM's pair. A pair counts only when the host catalog has it (provider available, model
 * listed, the critic's reasoning effort and service tier supported). With none left the writer's pair stays: this never
 * blocks an acceptance.
 */
export type Pair = { providerId: string; model: string };

/** What the host catalog says, narrowed to what the check needs. */
export type CriticCatalog = {
  provider(providerId: string): Promise<{ id: string; available: boolean; supportsServiceTier: boolean; serviceTiers: string[] } | null>;
  models(providerId: string): Promise<Array<{ id: string; model: string; efforts: string[] }>>;
};

const STAGE_SELECTION_KEYS = ["plan_critique", "specialist", "pm_read", "night_review", "docs", "project_life", "memory", "onboarding"] as const;

const same = (a: Pair, b: Pair) => a.providerId === b.providerId && a.model === b.model;
const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;

/** The pairs to try, in order: each stage's selection (both provider and model set), then the PM's; no repeats. */
export function criticPairCandidates(settings: Record<string, unknown>, config: { pmProviderId: string; pmModel: string }): Pair[] {
  const all: Pair[] = [];
  for (const stage of STAGE_SELECTION_KEYS) {
    const providerId = text(settings[`${stage}.provider`]);
    const model = text(settings[`${stage}.model`]);
    if (providerId && model) all.push({ providerId, model });
  }
  if (config.pmProviderId && config.pmModel) all.push({ providerId: config.pmProviderId, model: config.pmModel });
  return all.filter((pair, index) => all.findIndex((other) => same(other, pair)) === index);
}

export async function usable(catalog: CriticCatalog, pair: Pair, effort: string, tier: "fast" | "standard"): Promise<boolean> {
  const provider = await catalog.provider(pair.providerId);
  if (!provider?.available) return false;
  const model = findModelIn(await catalog.models(pair.providerId), pair.model);
  if (!model || !model.efforts.includes(effort)) return false;
  const serviceTier = provider.supportsServiceTier ? bbServiceTier(tier) : null;
  return !serviceTier || provider.serviceTiers.includes(serviceTier);
}

export async function pairApartFromWriter(input: {
  current: Pair; writer: Pair | null; candidates: readonly Pair[]; effort: string; tier: "fast" | "standard"; catalog: CriticCatalog;
}): Promise<{ pair: Pair; changed: boolean }> {
  const keep = { pair: input.current, changed: false };
  if (!input.writer || !same(input.current, input.writer)) return keep;
  for (const candidate of input.candidates) {
    if (same(candidate, input.writer)) continue;
    try {
      if (await usable(input.catalog, candidate, input.effort, input.tier)) return { pair: candidate, changed: true };
    } catch { return keep; }
  }
  return keep;
}

export type RoleSelection = { providerId: string; model: string; effort: string | null; source: RoleModelSource | "fallback"; issues?: string[] };

/**
 * A critic pair whose provider is nearly spent (`spent`) takes its peer in the other family when the host offers it (`usage_moved`). For a
 * code critic the work's author is the writer: a move that puts the critic into the writer's family is allowed and says
 * `same_family_judge_by_limit`. Returns the pair unchanged when nothing moves.
 */
export async function criticOffSpent(input: { critic: Pair; writer?: Pair | null; spent: SpentProbe | undefined; effort: string; tier: "fast" | "standard"; catalog: CriticCatalog }): Promise<{ pair: Pair; issues: string[] }> {
  if (!input.spent?.(input.critic.providerId, input.critic.model)) return { pair: input.critic, issues: [] };
  // The probe and the catalog answer separately: the peer must be offered by the host (asked first) and have room.
  const peer = peerOffSpent(input.critic, input.spent);
  if (!peer) return { pair: input.critic, issues: [] };
  try { if (!(await usable(input.catalog, peer, input.effort, input.tier))) return { pair: input.critic, issues: [] }; } catch { return { pair: input.critic, issues: [] }; }
  const issues = [peer.issue];
  if (input.writer && modelFamily(peer.model) && modelFamily(peer.model) === modelFamily(input.writer.model)) issues.push(SAME_FAMILY_JUDGE_BY_LIMIT);
  return { pair: { providerId: peer.providerId, model: peer.model }, issues };
}

/**
 * The model of a pipeline stage (pm-reader, plan-critic, code-critic, specialist-reviewer) from the one role table: the owner's row, else the
 * stage selection set before the table, else the built-in default (packages/models/src/role-models.ts). A pick the host does not offer, or
 * whose effort it lacks, gives way to `fallback` (what the stage ran on before the table: its own selection, else the writer's), and the
 * stage never stops for it. `effort` is null for the fallback: the stage's own effort rules apply then.
 */
export async function roleSelection(input: {
  catalog: CriticCatalog; settings: Record<string, unknown>; role: string; fallback: Pair; tier?: "fast" | "standard"; spent?: SpentProbe | undefined;
}): Promise<RoleSelection> {
  const chosen = resolveRoleModel(input.role, input.settings);
  try {
    if (await usable(input.catalog, chosen, chosen.effort, input.tier ?? "standard")) {
      // The limit of the table pick's provider moves the stage to the other family (the stage's author is not known here: only the code critic is judged against one).
      const off = await criticOffSpent({ critic: chosen, spent: input.spent, effort: chosen.effort, tier: input.tier ?? "standard", catalog: input.catalog });
      return { providerId: off.pair.providerId, model: off.pair.model, effort: chosen.effort, source: chosen.source, ...(off.issues.length ? { issues: off.issues } : {}) };
    }
  } catch { /* the catalog cannot be read: the stage's old pick stands */ }
  return { providerId: input.fallback.providerId, model: input.fallback.model, effort: null, source: "fallback" };
}

/** The cross-family rule for the code critic: the critic is of another family than the writer's model (Opus <-> Sol, Sonnet <-> Terra, Haiku <-> Luna) when the host has the peer. */
export async function criticAcrossFamilies(input: { critic: Pair; writer: Pair | null; effort: string; tier: "fast" | "standard"; catalog: CriticCatalog }): Promise<{ pair: Pair; changed: boolean }> {
  const judged = judgeAgainstAuthor(input.critic, input.writer);
  if (!judged.changed) return { pair: input.critic, changed: false };
  const peer = { providerId: judged.providerId, model: judged.model };
  try { if (await usable(input.catalog, peer, input.effort, input.tier)) return { pair: peer, changed: true }; } catch { /* keep the critic */ }
  return { pair: input.critic, changed: false };
}

/** The pair of the task's latest attempt that has a reasoning trace (the writer that produced the work), or null. */
export function latestWriterPair(db: LanePilotDatabase, runId: string, taskId: string): Pair | null {
  for (const attempt of [...listAttemptsForTask(db, runId, taskId)].reverse()) {
    const trace = getReasoningTrace(db, attempt.id);
    if (trace?.providerId && trace.model) return { providerId: trace.providerId, model: trace.model };
  }
  return null;
}

/** The host catalog through the BB SDK; the provider list is read once. */
export function sdkCriticCatalog(bb: Pick<BbPluginApi, "sdk">, hostId: string): CriticCatalog {
  let providers: Promise<Awaited<ReturnType<BbPluginApi["sdk"]["providers"]["list"]>>> | null = null;
  return {
    async provider(providerId) {
      providers ??= Promise.resolve(bb.sdk.providers.list({ hostId }));
      const row = (await providers).find((item) => item.id === providerId);
      return row ? { id: row.id, available: Boolean(row.available), supportsServiceTier: Boolean(row.capabilities?.supportsServiceTier),
        serviceTiers: (row.serviceTiers ?? []).map((item) => item.id) } : null;
    },
    async models(providerId) {
      const listed = await bb.sdk.providers.models({ providerId, hostId });
      return listed.models.map((row) => ({ id: row.id, model: row.model, efforts: row.supportedReasoningEfforts.map((item) => item.reasoningEffort) }));
    },
  };
}

import {
  ACTIVE_HYPOTHESIS_STATES,
  EVOLVE_THRESHOLDS,
  type ArmKind,
} from "@lane-pilot/contracts";
import type { ModelCatalog } from "@lane-pilot/models";
import {
  applyDraftOps,
  computeEnvironmentFingerprint,
  fallbackRates,
  formChainOf,
  nodeCensus,
  permissionDiff,
  planConfigSchema,
  replayCasesFromRuns,
  wfNodesWithEffects,
  type GraphNode,
  type PlanConfig,
  type ReplayCase,
  type ScriptConfig,
  type Workflow,
} from "@lane-pilot/workflow-engine";
import type { LeadRoadApi } from "../../../contracts";
import { createModelCatalog } from "../../../platform/server";
import type { loadProjectSettings } from "../../../storage";
import { makeLogSink, readMergedSettings } from "./context";
import {
  extractCheckFromRoad,
  findCheckFromRejectedVerdict,
  hasMechanicalVerify,
  isJudgeLikeRole,
  isRecord,
  pickCheaperModelVariant,
  stepCostMicroUsd,
  type Hypothesis,
  type QueuedHypothesis,
  type RunVerdictLike,
} from "../../models/hypothesis";
import { parseEvolveSettings } from "../../settings";
import { splitForRunId, workingCases, type EvolveCaseDb, type EvolveLogSink } from "../repositories/case-repository";
import {
  addNegative,
  hasNegative,
  listHypotheses,
  queueHypothesis,
  variantSignature,
  type EvolveLedgerDb,
} from "../repositories/ledger-repository";

export type { Hypothesis, QueuedHypothesis, RunVerdictLike };

export type PlanGenerator = (input: {
  workflowId: string;
  nodeId: string;
  role: string;
  prompt: string;
  outputs: ReadonlyArray<Record<string, unknown>>;
}) => Promise<PlanConfig | null> | PlanConfig | null;

export type ScriptGenerator = (input: {
  workflowId: string;
  nodeId: string;
  role: string;
  prompt: string;
  outputs: ReadonlyArray<Record<string, unknown>>;
}) => Promise<ScriptConfig | null> | ScriptConfig | null;

export type ProposeHypothesesCtx = {
  db: EvolveCaseDb & EvolveLedgerDb & Parameters<typeof nodeCensus>[0] & Parameters<typeof loadProjectSettings>[0];
  workflow?: Workflow | null | undefined;
  loadWorkflow?: ((workflowId: string) => Workflow | null | Promise<Workflow | null>) | undefined;
  projectId?: string | null | undefined;
  hostId?: string | null | undefined;
  settings?: Record<string, unknown> | undefined;
  catalog?: ModelCatalog | null | undefined;
  readCatalog?: (() => Promise<ModelCatalog | null>) | undefined;
  bb?: Parameters<typeof createModelCatalog>[0]["bb"] | undefined;
  log?: EvolveLogSink | ((message: string) => void) | undefined;
  leadRoad?: Pick<LeadRoadApi, "listRoad" | "doneRoad"> | undefined;
  listRunVerdicts?: ((filter: { workflowId?: string; since?: number; limit?: number }) => readonly RunVerdictLike[]) | undefined;
  generatePlan?: PlanGenerator | undefined;
  generateScript?: ScriptGenerator | undefined;
  computeFingerprint?: (() => string | null | undefined) | undefined;
};

type CandidateProposal = Hypothesis & {
  expectedSaving: number;
  isDemotion: boolean;
  roadId?: string;
};

const DOMINANT_SHARE = 0.3;
const SCRIPT_COST_SHARE_MIN = 0.1;

/**
 * Generates and queues up to `activeCap` node-level evolution hypotheses for a graph
 * from fallback rates, working-set node census, lead road branch rows, and owner wrong_result verdicts.
 */
export async function proposeHypotheses(
  ctx: ProposeHypothesesCtx,
  input: { workflowId: string; now?: number },
): Promise<QueuedHypothesis[]> {
  const log = makeLogSink(ctx);
  const workflowId = input.workflowId.trim();
  const now = input.now ?? Date.now();
  const settings = readMergedSettings(ctx);
  const evolveCfg = parseEvolveSettings(settings);

  if (!evolveCfg.enabled) {
    log.warn(`evolve propose skipped wf=${workflowId}: disabled`);
    return [];
  }
  if (!evolveCfg.graphs.includes(workflowId)) {
    log.warn(`evolve propose skipped wf=${workflowId}: not allow-listed`);
    return [];
  }

  const workflow = ctx.workflow ?? (await ctx.loadWorkflow?.(workflowId)) ?? null;
  if (!workflow) {
    log.warn(`evolve propose skipped wf=${workflowId}: workflow not found`);
    return [];
  }

  const graphVersion = workflow.version;
  const nodeById = new Map(
    workflow.nodes.filter((node): node is GraphNode => node.type !== "note").map((node) => [node.id, node]),
  );
  const activeSigs = new Set(
    listHypotheses(ctx.db, { workflowId, state: ACTIVE_HYPOTHESIS_STATES }).map((h) => h.variantSignature),
  );
  const isBlocked = (nodeId: string, armKind: ArmKind, variant: Record<string, unknown>): "active" | "negative" | null => {
    const sig = variantSignature(nodeId, armKind, variant);
    if (activeSigs.has(sig)) return "active";
    if (hasNegative(ctx.db, workflowId, nodeId, sig, graphVersion)) return "negative";
    return null;
  };

  // 1. Demotions (source "fallback", safety direction, always first, bypasses activeCap).
  const demotions: CandidateProposal[] = [];
  for (const rate of fallbackRates(ctx.db, { workflowId })) {
    if (rate.graphVersion !== graphVersion || rate.rate === null || rate.rate <= EVOLVE_THRESHOLDS.fallbackDemote) continue;
    const node = nodeById.get(rate.nodeId);
    if (!node || node.type !== "agent" || (node.form ?? "agent") !== rate.form) continue;
    const nextForm = formChainOf(node)[1];
    if (!nextForm) continue;
    const variant: Record<string, unknown> = nextForm === "plan"
      ? { form: "plan", fallback: "agent" }
      : { form: "agent", ...(node.fallback !== undefined ? { fallback: null } : {}) };
    if (isBlocked(node.id, "form", variant)) continue;
    demotions.push({
      workflowId,
      nodeId: node.id,
      armKind: "form",
      variant,
      source: "fallback",
      graphVersion,
      expectedSaving: Number.MAX_SAFE_INTEGER,
      isDemotion: true,
    });
  }

  const working = workingCases(ctx.db, workflowId);
  if (working.length === 0 && demotions.length === 0) {
    log.warn(`evolve propose skipped wf=${workflowId}: no cases`);
    return [];
  }

  const candidates: CandidateProposal[] = [];
  const workingRunIds = working.map((c) => c.runId);
  const census = workingRunIds.length
    ? nodeCensus(ctx.db, { workflowId, runIds: workingRunIds, graphVersion })
    : [];
  const censusByNode = new Map(census.map((entry) => [entry.nodeId, entry]));

  // 2. Model arms & Form arms from working-set node census.
  if (census.length > 0) {
    const catalog = ctx.catalog !== undefined
      ? ctx.catalog
      : ctx.readCatalog
        ? await ctx.readCatalog().catch(() => null)
        : ctx.bb
          ? await createModelCatalog({ bb: ctx.bb, log: (m) => log.debug(m) }).get().catch(() => null)
          : null;
    const hostId = ctx.hostId ?? catalog?.runHostId ?? null;
    const nodesWithEffects = wfNodesWithEffects(ctx.db as never, workingRunIds);

    const acceptedWorkingIds = working.filter((c) => c.verdict === "accept").slice(0, 3).map((c) => c.runId);
    let acceptedReplays: ReplayCase[] | null = null;
    const getAcceptedOutputs = (nodeId: string): Array<Record<string, unknown>> => {
      if (!acceptedReplays) {
        acceptedReplays = acceptedWorkingIds.length
          ? replayCasesFromRuns(ctx.db as never, workflowId, { runIds: acceptedWorkingIds, workflow }).cases
          : [];
      }
      return acceptedReplays
        .map((rc) => rc.recorded[nodeId])
        .filter((out): out is Record<string, unknown> => isRecord(out))
        .slice(0, 3);
    };

    for (const entry of census) {
      const node = nodeById.get(entry.nodeId);
      if (!node || node.type !== "agent") continue;
      const saving = entry.costShare * stepCostMicroUsd(entry);

      if (
        entry.classification === "stable_agent" &&
        (entry.costShare >= DOMINANT_SHARE || entry.durationShare >= DOMINANT_SHARE) &&
        !isJudgeLikeRole(node.role)
      ) {
        const variant = pickCheaperModelVariant({
          node,
          settings,
          catalog,
          hostId,
          isAllowed: (cand) => !isBlocked(node.id, "model", cand),
        });
        if (variant) {
          candidates.push({
            workflowId,
            nodeId: node.id,
            armKind: "model",
            variant,
            source: "census",
            graphVersion,
            expectedSaving: saving,
            isDemotion: false,
          });
        }
      }

      if (entry.formArmCandidate) {
        const currentForm = node.form ?? "agent";
        let scriptProposed = false;
        if (currentForm !== "script") {
          let fp: string | null | undefined = null;
          try {
            fp = (ctx.computeFingerprint ?? computeEnvironmentFingerprint)();
          } catch {
            fp = null;
          }
          const hasFingerprint = typeof fp === "string" && fp.trim().length > 0;
          const effectGuarded = node.effect === "R" || node.effect === "D" || nodesWithEffects.has(node.id);
          const canScript =
            entry.classification === "stable_agent" &&
            hasMechanicalVerify(node) &&
            entry.costShare >= SCRIPT_COST_SHARE_MIN &&
            effectGuarded &&
            hasFingerprint;

          if (canScript) {
            let scriptCfg: Record<string, unknown> | null = null;
            if (node.script) {
              scriptCfg = { ...node.script, fingerprint: fp!.trim() };
            } else if (ctx.generateScript) {
              try {
                const generated = await ctx.generateScript({
                  workflowId,
                  nodeId: node.id,
                  role: node.role,
                  prompt: node.prompt,
                  outputs: getAcceptedOutputs(node.id),
                });
                if (generated) scriptCfg = { ...generated, fingerprint: fp!.trim() };
                else log.warn(`evolve propose skipped wf=${workflowId}: helper failed`);
              } catch {
                log.warn(`evolve propose skipped wf=${workflowId}: helper failed`);
              }
            } else {
              scriptCfg = { fingerprint: fp!.trim() };
            }
            if (scriptCfg) {
              const variant: Record<string, unknown> = {
                form: "script",
                fallback: node.plan !== undefined ? "plan" : "agent",
                script: scriptCfg,
              };
              if (!isBlocked(node.id, "form", variant)) {
                candidates.push({
                  workflowId,
                  nodeId: node.id,
                  armKind: "form",
                  variant,
                  source: "census",
                  graphVersion,
                  expectedSaving: saving,
                  isDemotion: false,
                });
                scriptProposed = true;
              }
            }
          }
        }

        if (!scriptProposed && currentForm === "agent" && node.plan === undefined && ctx.generatePlan) {
          try {
            const rawPlan = await ctx.generatePlan({
              workflowId,
              nodeId: node.id,
              role: node.role,
              prompt: node.prompt,
              outputs: getAcceptedOutputs(node.id),
            });
            const parsed = rawPlan ? planConfigSchema.safeParse(rawPlan) : null;
            if (!parsed?.success) {
              log.warn(`evolve propose skipped wf=${workflowId}: helper failed`);
            } else {
              const variant: Record<string, unknown> = { form: "plan", fallback: "agent", plan: parsed.data };
              if (!isBlocked(node.id, "form", variant)) {
                candidates.push({
                  workflowId,
                  nodeId: node.id,
                  armKind: "form",
                  variant,
                  source: "census",
                  graphVersion,
                  expectedSaving: saving,
                  isDemotion: false,
                });
              }
            }
          } catch {
            log.warn(`evolve propose skipped wf=${workflowId}: helper failed`);
          }
        }
      }
    }
  }

  // 3. Check arms from lead_road (`class: "branch"` with `payload.graphId`) and owner `wrong_result` verdicts.
  if (ctx.leadRoad) {
    const roadRows = ctx.leadRoad.listRoad(ctx.db as never, { state: ["open", "proposed", "accepted", "later"], limit: 100 });
    for (const row of roadRows) {
      if (row.class !== "branch") continue;
      const extracted = extractCheckFromRoad(workflow, nodeById, row);
      if (!extracted) continue;
      const blocked = isBlocked(extracted.nodeId, "check", extracted.variant);
      if (blocked === "negative") {
        ctx.leadRoad.doneRoad(ctx.db as never, row.id, "already in negative archive", now);
        continue;
      }
      if (blocked === "active") continue;
      const ce = censusByNode.get(extracted.nodeId);
      candidates.push({
        workflowId,
        nodeId: extracted.nodeId,
        armKind: "check",
        variant: extracted.variant,
        source: "lead_road",
        graphVersion,
        expectedSaving: ce ? ce.costShare * stepCostMicroUsd(ce) : 0,
        isDemotion: false,
        roadId: row.id,
      });
    }
  }

  if (ctx.listRunVerdicts) {
    const workingIdSet = new Set(workingRunIds);
    const verdicts = ctx.listRunVerdicts({ workflowId, limit: 200 }).filter(
      (v) =>
        v.verdict === "reject" &&
        v.reason === "wrong_result" &&
        v.graphVersion === graphVersion &&
        (workingIdSet.has(v.runId) || splitForRunId(v.runId) === "working"),
    );
    if (verdicts.length > 0) {
      const replayMap = new Map(
        replayCasesFromRuns(ctx.db as never, workflowId, {
          runIds: verdicts.map((v) => v.runId),
          workflow,
        }).cases.map((c) => [c.runId, c]),
      );
      for (const v of verdicts) {
        const extracted = findCheckFromRejectedVerdict(workflow, nodeById, v, replayMap.get(v.runId));
        if (!extracted || isBlocked(extracted.nodeId, "check", extracted.variant)) continue;
        const ce = censusByNode.get(extracted.nodeId);
        candidates.push({
          workflowId,
          nodeId: extracted.nodeId,
          armKind: "check",
          variant: extracted.variant,
          source: "owner",
          graphVersion,
          expectedSaving: ce ? ce.costShare * stepCostMicroUsd(ce) : 0,
          isDemotion: false,
        });
      }
    }
  }

  candidates.sort((a, b) => b.expectedSaving - a.expectedSaving || a.nodeId.localeCompare(b.nodeId));
  const ordered = [...demotions, ...candidates];

  const queued: QueuedHypothesis[] = [];
  const counts = { demote: 0, model: 0, form: 0, check: 0 };

  for (const cand of ordered) {
    if (isBlocked(cand.nodeId, cand.armKind, cand.variant)) continue;
    const appliedCand = applyDraftOps(
      workflow as unknown as Record<string, unknown>,
      [{ op: "update_node", id: cand.nodeId, set: cand.variant }],
      { evolutionGate: true, source: "evolve" },
    );
    const diffs = appliedCand.ok ? permissionDiff(workflow, appliedCand.definition) : [];
    if (!appliedCand.ok || diffs.length > 0) {
      log.warn(`draft guard source=evolve draft=${cand.workflowId} widening=${Math.max(1, diffs.length)}`);
      addNegative(ctx.db, {
        workflowId: cand.workflowId,
        nodeId: cand.nodeId,
        armKind: cand.armKind,
        variant: cand.variant,
        graphVersion: cand.graphVersion,
        reason: "widens_permissions",
        now,
      });
      if (cand.roadId && ctx.leadRoad) {
        ctx.leadRoad.doneRoad(ctx.db as never, cand.roadId, "widens_permissions", now);
      }
      continue;
    }
    const res = queueHypothesis(
      ctx.db,
      {
        workflowId: cand.workflowId,
        nodeId: cand.nodeId,
        armKind: cand.armKind,
        variant: cand.variant,
        graphVersion: cand.graphVersion,
        source: cand.source,
        now,
        ...(cand.isDemotion ? { bypassCap: true } : {}),
      },
      log,
    );
    if (!res.ok) {
      if (res.reason === "cap" && !cand.isDemotion) break;
      continue;
    }
    activeSigs.add(res.hypothesis.variantSignature);
    queued.push({
      id: res.hypothesis.id,
      workflowId: cand.workflowId,
      nodeId: cand.nodeId,
      armKind: cand.armKind,
      variant: cand.variant,
      source: cand.source,
      graphVersion: cand.graphVersion,
    });
    if (cand.isDemotion) counts.demote += 1;
    else if (cand.armKind === "model") counts.model += 1;
    else if (cand.armKind === "form") counts.form += 1;
    else if (cand.armKind === "check") counts.check += 1;

    if (cand.roadId && ctx.leadRoad) {
      ctx.leadRoad.doneRoad(ctx.db as never, cand.roadId, `queued hypothesis ${res.hypothesis.id}`, now);
    }
  }

  log.info(
    `evolve propose wf=${workflowId} n=${queued.length} demote=${counts.demote} model=${counts.model} form=${counts.form} check=${counts.check}`,
  );
  return queued;
}

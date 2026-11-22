// Topological validation, stub-testing, and CAS publishing for synthesized graph-evolve subworkflow suites.
// Disk reads go through workflow-engine's nodeFileSource (no direct node:fs in server/).
import { join } from "node:path";
import { redactKnown, sha256Hex } from "@lane-pilot/kit";
import { globalSkillsDir, loadWorkflow, runDraftTest, testCasesOf, type StoredSkillBundleFile, type Workflow } from "@lane-pilot/workflow-engine";
import type { ServerCore } from "../../contracts/server";
import { markTrajectoryDeltasProcessed } from "../../errands";
import { postOwnerItem, rpcLine } from "../../owner-waiting";
import {
  HARNESS_VERSION, casWriteWorkflowFile, createDraftStore, createStatusResolver, definitionSha256,
  globalWorkflowDir, loadWorkflowStore, nodeFileSource, type DraftStore, type PilotDayCategoryHint, type SupersededWorkflowSnapshot,
} from "../../storage";
import { BUILTIN_SOURCES, builtinWorkflow, isBuiltinWorkflowCategory, workflowCategory } from "../../workflow";
import { createWorkflowArchitect, type ArchitectDeps, type WorkflowArchitect } from "../../workflow/server";
import { checkDeprojectization, classifyEvolutionDiff, type DeprojectizeContext } from "../deprojectize";
import { validateLeanSuitePolicy, type LeanPolicyViolation } from "../lean-suite-policy";
import type { ProcessBlueprint } from "../process-blueprint";
import {
  mapCompanionSkillsToWorkflows, publishMatchedSkillsOrRollbackWf, recordPublishedSkillEvolutionEvents,
  retireSupersededWorkflows, snapshotSkillBundles, stageCompanionSkillsForDraft, validateCompanionSkillCandidates,
  type PendingPublishedSkillEvent,
} from "./companion-skill-evolve";
import type { CompanionSkillCandidate } from "./companion-skill-merge";
import type { ArtifactSkeleton } from "./pilot-day-skeleton";

export type GraphEvolveCandidate = {
  workflowId: string; scope: "global" | "project"; projectId?: string | null;
  name: string | { en: string; ru: string }; description: string | { en: string; ru: string };
  category?: string | { id: string; label?: { en: string; ru: string } };
  definition: Record<string, unknown>; sourceDeltaIds?: string[]; sourceProcessKey?: string | null;
};

export type GraphEvolveCollectSummary = {
  clusters: Array<{
    processKey: string; count: number; topSkills: string[]; sampleGoals: string[]; traps: string[];
    lessons?: string[]; categoryHint?: PilotDayCategoryHint | null;
    artifactSkeletons?: ArtifactSkeleton[]; archetypeHints?: string[];
    overConstraintCount?: number; frictionSignals?: string[]; leanViolations?: string[];
  }>;
  deltas: Array<{ id: string; projectId: string | null; workflowId: string | null; stageArchetype: string; interventionKind: string; resolvedSkills: string[]; maskedSummary: string }>;
  deltaIds: string[]; status: "ready" | "empty"; leanDebtCount?: number;
};

export type GraphEvolveDeps = {
  db: ServerCore["db"]; globalDir?: () => string; skillsDir?: () => string; knownContext?: DeprojectizeContext;
  synthesize?: (collected: GraphEvolveCollectSummary) => Promise<GraphEvolveCandidate[]>;
  architectDeps?: Partial<ArchitectDeps>; architect?: Pick<WorkflowArchitect, "publish">;
  resolveWorkflow?: (id: string, version?: number) => Workflow | null;
  invalidateCatalog?: () => void;
  now?: () => number; log?: (message: string) => void;
};

export type GraphEvolveOutcome = {
  workflowId: string; draftId: string | null; kind: "minor_patch" | "structural_or_new";
  status: "auto_published" | "proposed_tested" | "rejected_deprojectize" | "rejected_invalid" | "rejected_tests" | "publish_failed";
  version: number | null; reason?: string;
};

type DiskBase = { path: string; sha256: string; version: number; def: Record<string, unknown>; raw: string };
type PreparedCandidate = {
  candidate: GraphEvolveCandidate; workflowId: string; projectId: string;
  candidateDef: Record<string, unknown>; finalDef: Record<string, unknown>;
  existing: ReturnType<DraftStore["listEvolutionDrafts"]>[number] | null;
  diskBase: DiskBase | null; baseDef: Record<string, unknown> | null;
  diff: ReturnType<typeof classifyEvolutionDiff>; shouldPublish: boolean;
  pass1Workflow: Workflow;
};

const bilingual = (v: string | { en: string; ru: string }) => typeof v === "string" ? { en: v, ru: v } : { en: v.en || v.ru, ru: v.ru || v.en };
const titleRuOf = (v: string | { en: string; ru: string }, fallback: string) => (typeof v === "string" ? v : v.ru || v.en) || fallback;
const fixEvolveLog = (log: (m: string) => void, event: string, detail: Record<string, unknown>) => {
  if (process.env.LOG_LEVEL === "debug" || process.env.DEBUG_FIX) log(`[FIX:graph-evolve] ${event} ${redactKnown(JSON.stringify(detail))}`);
};

export function extractSubworkflowRefs(workflow: Workflow): string[] {
  const refs: string[] = [];
  for (const node of workflow.nodes) {
    if (node.type === "subworkflow") refs.push(node.workflow);
    else if (node.type === "parallel" && node.child?.type === "subworkflow") refs.push(node.child.workflow);
  }
  return [...new Set(refs)];
}

/** Sorts Pass-1 valid suite items in leaves -> orchestrator order and isolates subworkflow cycles. */
export function topologicalSortSuite<T extends { workflowId: string; pass1Workflow: Workflow }>(
  items: readonly T[],
): { ordered: T[]; cyclic: T[] } {
  const indexById = new Map(items.map((item, idx) => [item.workflowId, idx]));
  const childrenByIdx = items.map((item) => extractSubworkflowRefs(item.pass1Workflow).filter((id) => indexById.has(id)));
  const parentsById = new Map<string, number[]>();
  const inDegree = new Array<number>(items.length).fill(0);
  for (let i = 0; i < items.length; i += 1) {
    inDegree[i] = childrenByIdx[i]!.length;
    for (const childId of childrenByIdx[i]!) {
      const list = parentsById.get(childId) ?? [];
      list.push(i);
      parentsById.set(childId, list);
    }
  }
  const insertSorted = (queue: number[], idx: number) => {
    const pos = queue.findIndex((q) => q > idx);
    if (pos < 0) queue.push(idx); else queue.splice(pos, 0, idx);
  };
  const queue = items.map((_, i) => i).filter((i) => inDegree[i] === 0);
  const done = new Set<number>();
  const ordered: T[] = [];
  const drain = () => {
    while (queue.length) {
      const u = queue.shift()!;
      if (done.has(u)) continue;
      done.add(u);
      ordered.push(items[u]!);
      for (const p of parentsById.get(items[u]!.workflowId) ?? []) {
        inDegree[p] -= 1;
        if (inDegree[p] === 0 && !done.has(p)) insertSorted(queue, p);
      }
    }
  };
  drain();

  const remaining = items.map((_, i) => i).filter((i) => !done.has(i));
  const canReachSelf = (startIdx: number): boolean => {
    const visited = new Set<number>();
    const stack = childrenByIdx[startIdx]!.map((id) => indexById.get(id)!);
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === startIdx) return true;
      if (visited.has(cur)) continue;
      visited.add(cur);
      for (const nextId of childrenByIdx[cur]!) {
        const nextIdx = indexById.get(nextId);
        if (nextIdx !== undefined) stack.push(nextIdx);
      }
    }
    return false;
  };
  const cyclic: T[] = [];
  const cyclicIdx = new Set(remaining.filter(canReachSelf));
  for (const idx of remaining) {
    if (!cyclicIdx.has(idx)) continue;
    done.add(idx);
    cyclic.push(items[idx]!);
    for (const p of parentsById.get(items[idx]!.workflowId) ?? []) {
      if (cyclicIdx.has(p) || done.has(p)) continue;
      inDegree[p] -= 1;
      if (inDegree[p] === 0) insertSorted(queue, p);
    }
  }
  drain();
  return { ordered, cyclic };
}

async function readDiskBase(dir: string, workflowId: string): Promise<DiskBase | null> {
  const path = join(dir, `${workflowId}.json`);
  try {
    const raw = await nodeFileSource.read(path);
    const def = JSON.parse(raw) as Record<string, unknown>;
    return { path, sha256: sha256Hex(raw), version: typeof def.version === "number" ? def.version : 1, def, raw };
  } catch { return null; }
}

function buildArchitect(deps: GraphEvolveDeps, dirFn: () => string): Pick<WorkflowArchitect, "publish"> {
  if (deps.architect) return deps.architect;
  const minCtx = { db: deps.db, log: deps.log ?? (() => undefined), realtime: { notify: () => undefined } } as unknown as ServerCore;
  const archDeps: ArchitectDeps = {
    globalDir: dirFn, projectPlace: async () => null, capabilityPorts: () => ({}), hasExecutor: () => false,
    writeProjectFile: async () => ({ status: "conflict", path: "", afterSha256: null, reason: "project_place_unknown" }),
    ...deps.architectDeps,
  };
  return createWorkflowArchitect(minCtx, { workflowEngine: { hasExecutor: archDeps.hasExecutor } } as never, archDeps);
}

type LeanOpts = { blueprint?: ProcessBlueprint | null; enforceLeanPolicy?: boolean; operator?: string };
const formatProblems = (problems: ReadonlyArray<{ level: string; code: string; message: string }>) =>
  problems.filter((p) => p.level === "error").map((p) => `${p.code}:${p.message}`).slice(0, 4).join("; ");

function evalLeanPolicy(
  items: ReadonlyArray<{ workflowId: string; candidate: GraphEvolveCandidate; candidateDef: Record<string, unknown> }>,
  options?: LeanOpts,
  log?: (m: string) => void,
): Map<string, LeanPolicyViolation[]> {
  const byWf = new Map<string, LeanPolicyViolation[]>();
  if (!options?.enforceLeanPolicy && !options?.blueprint && options?.operator !== "prune_or_relax") return byWf;
  const res = validateLeanSuitePolicy(items.map((i) => ({ workflowId: i.workflowId, scope: i.candidate.scope, definition: i.candidateDef })), { blueprint: options?.blueprint, log });
  for (const v of res.violations) { const list = byWf.get(v.workflowId) ?? []; list.push(v); byWf.set(v.workflowId, list); }
  return byWf;
}

function preparePass1Defs(candidate: GraphEvolveCandidate, existing: PreparedCandidate["existing"], diskBase: DiskBase | null, shouldPublish: boolean, candidateDef: Record<string, unknown>) {
  const workflowId = candidate.workflowId.trim();
  const projectId = existing?.projectId ?? (candidate.projectId?.trim() || "*");
  const targetVersion = shouldPublish ? (diskBase ? diskBase.version + 1 : 1) : (typeof candidateDef.version === "number" ? candidateDef.version : 1);
  const targetStatus = shouldPublish ? "published" : "draft";
  const finalDef: Record<string, unknown> = {
    ...candidateDef, id: workflowId, version: targetVersion, status: targetStatus,
    name: candidate.definition.name ?? bilingual(candidate.name),
    description: candidate.definition.description ?? bilingual(candidate.description),
    scope: candidate.scope === "project" ? { level: "project", projectId } : { level: "global" },
  };
  return { workflowId, projectId, finalDef };
}

/** Validates and stub-tests a candidate suite (and optional companion skills) without writing files or mutating drafts. */
export async function validateEvolveSuiteCandidates(
  deps: Pick<GraphEvolveDeps, "db" | "globalDir" | "skillsDir" | "knownContext" | "resolveWorkflow" | "now" | "log">,
  candidates: readonly GraphEvolveCandidate[],
  options?: { companionSkills?: readonly CompanionSkillCandidate[]; blueprint?: ProcessBlueprint | null; enforceLeanPolicy?: boolean; operator?: string },
): Promise<{ ok: boolean; errors: string[] }> {
  const now = deps.now ?? Date.now, log = deps.log ?? (() => undefined), dirFn = deps.globalDir ?? globalWorkflowDir;
  const baseStore = await loadWorkflowStore({ builtin: BUILTIN_SOURCES, globalDir: dirFn() }).catch(() => null);
  const errors: string[] = [], failedIds = new Set<string>(), suiteMap = new Map<string, Workflow>();
  const pass1Items: Array<{ workflowId: string; candidate: GraphEvolveCandidate; candidateDef: Record<string, unknown>; finalDef: Record<string, unknown>; pass1Workflow: Workflow }> = [];

  for (const candidate of candidates) {
    const workflowId = candidate.workflowId.trim();
    if (!workflowId || builtinWorkflow(workflowId)) { if (workflowId) failedIds.add(workflowId); errors.push(`${workflowId || "<empty>"}: id_reserved`); continue; }
    if (suiteMap.has(workflowId)) { errors.push(`${workflowId}: duplicate_workflow_id`); continue; }
    const category = candidate.definition.category ?? candidate.category;
    const candidateDef = category !== undefined && candidate.definition.category === undefined ? { ...candidate.definition, category } : candidate.definition;
    const diskBase = candidate.scope === "global" ? await readDiskBase(dirFn(), workflowId) : null;
    const { finalDef } = preparePass1Defs(candidate, null, diskBase, false, candidateDef);
    const loaded = loadWorkflow(finalDef);
    if (!loaded.ok) { failedIds.add(workflowId); errors.push(`${workflowId}: ${formatProblems(loaded.problems)}`); continue; }
    suiteMap.set(workflowId, loaded.workflow);
    pass1Items.push({ workflowId, candidate, candidateDef, finalDef, pass1Workflow: loaded.workflow });
  }

  const { ordered, cyclic } = topologicalSortSuite(pass1Items);
  for (const item of cyclic) { suiteMap.delete(item.workflowId); failedIds.add(item.workflowId); errors.push(`${item.workflowId}: subworkflow_cycle`); }
  for (const [wfId, vs] of evalLeanPolicy(pass1Items, options, log)) {
    suiteMap.delete(wfId); failedIds.add(wfId);
    errors.push(`${wfId}: lean_policy:${vs.map((v) => `${v.code}${v.nodeId ? `(${v.nodeId})` : ""}`).join(",")}`);
    log(`WARN [nightGraphs.graphEvolve] rejected_lean_policy ${redactKnown(JSON.stringify({ workflowId: wfId, codes: vs.map((v) => v.code) }))}`);
  }
  const resolveSuite = (id: string, version?: number): Workflow | null => {
    const s = suiteMap.get(id);
    return (s && (version === undefined || s.version === version)) ? s : (deps.resolveWorkflow?.(id, version) ?? baseStore?.resolve(id, version) ?? builtinWorkflow(id, version));
  };
  for (const item of ordered) {
    if (failedIds.has(item.workflowId)) continue;
    const badDep = extractSubworkflowRefs(item.pass1Workflow).find((dep) => failedIds.has(dep));
    if (badDep) { suiteMap.delete(item.workflowId); failedIds.add(item.workflowId); errors.push(`${item.workflowId}: dependency_failed:${badDep}`); continue; }
    if (item.candidate.scope === "global") {
      const verdict = checkDeprojectization(item.candidateDef, { ...deps.knownContext, log });
      if (!verdict.ok) { suiteMap.delete(item.workflowId); failedIds.add(item.workflowId); errors.push(`${item.workflowId}: deprojectize:${verdict.findings.map((f) => f.code).join(",")}`); continue; }
    }
    const full = loadWorkflow(item.finalDef, { resolve: resolveSuite });
    if (!full.ok) { suiteMap.delete(item.workflowId); failedIds.add(item.workflowId); errors.push(`${item.workflowId}: ${formatProblems(full.problems)}`); continue; }
    suiteMap.set(item.workflowId, full.workflow);
    for (const tc of testCasesOf(full.workflow)) {
      const res = await runDraftTest({ db: deps.db as never, harnessVersion: HARNESS_VERSION, resolveWorkflow: resolveSuite, now }, full.workflow, tc);
      if (!res.green) { suiteMap.delete(item.workflowId); failedIds.add(item.workflowId); errors.push(`${item.workflowId}: test ${tc.id}: ${res.failures.slice(0, 3).join("; ")}`); }
    }
  }
  if (options?.companionSkills?.length) {
    errors.push(...await validateCompanionSkillCandidates((deps.skillsDir ?? globalSkillsDir)(), options.companionSkills, { deprojectize: deps.knownContext, log }));
  }
  return { ok: errors.length === 0, errors };
}

/** Validates, de-projectizes, tests on stubs in leaves -> orchestrator order, and publishes or proposes each candidate. */
export async function applyGraphEvolveCandidates(
  deps: GraphEvolveDeps,
  candidates: readonly GraphEvolveCandidate[],
  options?: {
    deltaIds?: readonly string[]; publishApprovedSuite?: boolean; auditVerdict?: string;
    companionSkills?: readonly CompanionSkillCandidate[]; operator?: string; supersededWorkflowIds?: readonly string[];
    blueprint?: ProcessBlueprint | null; enforceLeanPolicy?: boolean;
  },
): Promise<{ outcomes: GraphEvolveOutcome[]; publishedCount: number; proposedCount: number; rejectedCount: number; summary: string }> {
  const now = deps.now ?? Date.now, log = deps.log ?? (() => undefined), dirFn = deps.globalDir ?? globalWorkflowDir, skillsFn = deps.skillsDir ?? globalSkillsDir;
  const drafts = createDraftStore(deps.db, now), architect = buildArchitect(deps, dirFn);
  const baseStore = await loadWorkflowStore({ builtin: BUILTIN_SOURCES, globalDir: dirFn() }).catch(() => null);
  const outcomes: GraphEvolveOutcome[] = [];
  let publishedCount = 0, proposedCount = 0, rejectedCount = 0, citedAnyDelta = false;
  const failedSuiteIds = new Set<string>(), suiteMap = new Map<string, Workflow>(), preparedList: PreparedCandidate[] = [];
  const auditPassed = options?.auditVerdict === undefined || options.auditVerdict === "pass";
  const rejectInvalid = (workflowId: string, kind: GraphEvolveOutcome["kind"], reason: string, event: string, detail: Record<string, unknown>) => {
    suiteMap.delete(workflowId); failedSuiteIds.add(workflowId);
    log(`WARN [nightGraphs.graphEvolve] ${event} ${redactKnown(JSON.stringify(detail))}`);
    outcomes.push({ workflowId, draftId: null, kind, status: "rejected_invalid", version: null, reason });
    rejectedCount += 1;
  };

  for (const candidate of candidates) {
    const workflowId = candidate.workflowId.trim();
    if (!workflowId || builtinWorkflow(workflowId)) { rejectInvalid(workflowId, "structural_or_new", "id_reserved", "reserved_or_empty", { workflowId }); continue; }
    if (suiteMap.has(workflowId)) { outcomes.push({ workflowId, draftId: null, kind: "structural_or_new", status: "rejected_invalid", version: null, reason: "duplicate_workflow_id" }); rejectedCount += 1; continue; }
    const category = candidate.definition.category ?? candidate.category;
    const candidateDef = category !== undefined && candidate.definition.category === undefined ? { ...candidate.definition, category } : candidate.definition;
    const existing = drafts.listEvolutionDrafts({ workflowId, scope: candidate.scope, ...(candidate.scope === "project" && candidate.projectId ? { projectId: candidate.projectId } : {}) })[0] ?? null;
    const diskBase = candidate.scope === "global" ? await readDiskBase(dirFn(), workflowId) : null;
    const baseDef = existing?.publishedVersion ? (drafts.latestPublishedSnapshot(existing.id)?.definition ?? diskBase?.def ?? null) : (diskBase?.def ?? null);
    const diff = classifyEvolutionDiff(baseDef, candidateDef, { log });
    const isPruneExisting = options?.operator === "prune_or_relax" && Boolean(baseDef);
    const wouldPublish = Boolean((diff.kind === "minor_patch" && baseDef) || isPruneExisting || options?.publishApprovedSuite);
    const shouldPublish = Boolean(auditPassed && wouldPublish);
    if (!auditPassed && wouldPublish) log(`INFO [nightGraphs.graphEvolve] held_without_audit_pass ${redactKnown(JSON.stringify({ workflowId, auditVerdict: options?.auditVerdict }))}`);
    const { projectId, finalDef } = preparePass1Defs(candidate, existing, diskBase, shouldPublish, candidateDef);
    const loaded1 = loadWorkflow(finalDef);
    if (!loaded1.ok) { rejectInvalid(workflowId, diff.kind, formatProblems(loaded1.problems), "invalid_workflow", { workflowId, reason: formatProblems(loaded1.problems) }); continue; }
    suiteMap.set(workflowId, loaded1.workflow);
    preparedList.push({ candidate, workflowId, projectId, candidateDef, finalDef, existing, diskBase, baseDef, diff, shouldPublish, pass1Workflow: loaded1.workflow });
  }

  const { ordered, cyclic } = topologicalSortSuite(preparedList);
  for (const item of cyclic) rejectInvalid(item.workflowId, item.diff.kind, "subworkflow_cycle", "invalid_workflow", { workflowId: item.workflowId, reason: "subworkflow_cycle" });
  if (ordered.length) log(`INFO [nightGraphs.graphEvolve] suite_topology ${redactKnown(JSON.stringify({ order: ordered.map((i) => i.workflowId) }))}`);
  const resolveSuite = (id: string, version?: number): Workflow | null => {
    const s = suiteMap.get(id);
    return (s && (version === undefined || s.version === version)) ? s : (deps.resolveWorkflow?.(id, version) ?? baseStore?.resolve(id, version) ?? builtinWorkflow(id, version));
  };
  const companionSkills = options?.companionSkills ?? [];
  const skillsByWf = mapCompanionSkillsToWorkflows(ordered.map((o) => o.workflowId), new Set(candidates.map((c) => c.workflowId.trim())), companionSkills);
  const initialSkillReads = companionSkills.length ? await snapshotSkillBundles(skillsFn(), companionSkills, log) : new Map();
  const publishedSkillsInRun = new Map<string, { beforeFiles: StoredSkillBundleFile[]; beforeBundleSha256: string | null; afterBundleSha256: string | null }>();
  const pendingPublishedEvents: PendingPublishedSkillEvent[] = [];
  let lastPublishedTarget: { draftId: string; draftVersion: number; workflowId: string; operator: string } | null = null;
  const operator = options?.operator?.trim() || "graph_evolve";
  const supersededIds = options?.supersededWorkflowIds ?? [];
  const leanByWf = evalLeanPolicy(ordered.filter((i) => i.candidate.scope === "global"), options, log);

  for (let itemIdx = 0; itemIdx < ordered.length; itemIdx += 1) {
    const item = ordered[itemIdx]!;
    const { candidate, workflowId, projectId, candidateDef, finalDef, existing, diskBase, baseDef, diff, shouldPublish, pass1Workflow } = item;
    const failedDep = extractSubworkflowRefs(pass1Workflow).find((depId) => failedSuiteIds.has(depId));
    if (failedDep) { rejectInvalid(workflowId, diff.kind, `dependency_failed:${failedDep}`, "dependency_failed", { workflowId, failedDep }); continue; }
    if (candidate.scope === "global") {
      const verdict = checkDeprojectization(candidateDef, { ...deps.knownContext, log });
      if (!verdict.ok) {
        suiteMap.delete(workflowId); failedSuiteIds.add(workflowId);
        const codes = verdict.findings.map((f) => f.code).join(",");
        log(`WARN [nightGraphs.graphEvolve] deprojectize_failed ${redactKnown(JSON.stringify({ workflowId, codes }))}`);
        outcomes.push({ workflowId, draftId: null, kind: diff.kind, status: "rejected_deprojectize", version: null, reason: codes });
        rejectedCount += 1; continue;
      }
    }
    const leanVs = leanByWf.get(workflowId);
    if (leanVs?.length) {
      const codes = leanVs.map((v) => v.code);
      rejectInvalid(workflowId, diff.kind, `lean_policy:${codes.join(",")}`, "rejected_lean_policy", { workflowId, codes });
      continue;
    }
    const fullLoaded = loadWorkflow(finalDef, { resolve: resolveSuite });
    if (!fullLoaded.ok) { const reason = formatProblems(fullLoaded.problems); rejectInvalid(workflowId, diff.kind, reason, "invalid_workflow", { workflowId, reason }); continue; }
    suiteMap.set(workflowId, fullLoaded.workflow);
    log(`INFO [nightGraphs.graphEvolve] category_selected ${redactKnown(JSON.stringify({ workflowId, categoryId: fullLoaded.workflow.category?.id ?? workflowCategory(fullLoaded.workflow), isDynamic: Boolean(fullLoaded.workflow.category && !isBuiltinWorkflowCategory(fullLoaded.workflow.category.id)) }))}`);

    const results = [];
    for (const tc of testCasesOf(fullLoaded.workflow)) results.push(await runDraftTest({ db: deps.db as never, harnessVersion: HARNESS_VERSION, resolveWorkflow: resolveSuite, now }, fullLoaded.workflow, tc));
    const allGreen = results.length > 0 && results.every((r) => r.green);
    if (!allGreen) {
      suiteMap.delete(workflowId); failedSuiteIds.add(workflowId);
      fixEvolveLog(log, "rejected_before_mutate", { workflowId, existingDraftId: existing?.id ?? null, cases: results.length });
      log(`WARN [nightGraphs.graphEvolve] tested ${redactKnown(JSON.stringify({ workflowId, draftId: existing?.id ?? null, cases: results.length, green: false }))}`);
      outcomes.push({ workflowId, draftId: existing?.id ?? null, kind: diff.kind, status: "rejected_tests", version: null, reason: results.filter((r) => !r.green).flatMap((r) => r.failures).slice(0, 4).join("; ") || "draft_test_failed" });
      rejectedCount += 1; continue;
    }

    const draftDef = { ...finalDef, status: "draft" };
    const draft = existing && (!diskBase || existing.publishedSha256 === diskBase.sha256)
      ? drafts.replaceDefinition(existing.id, draftDef, `nightly evolution (${diff.kind})`)!
      : diskBase
        ? drafts.replaceDefinition(drafts.create({ projectId, threadId: null, scope: candidate.scope, name: candidate.name, description: candidate.description, workflowId, definition: diskBase.def, base: { path: diskBase.path, sha256: diskBase.sha256, version: diskBase.version } }).id, draftDef, `nightly evolution (${diff.kind})`)!
        : drafts.create({ projectId, threadId: null, scope: candidate.scope, name: candidate.name, description: candidate.description, workflowId, definition: draftDef });
    const recorded = drafts.recordTests(draft.id, draft.version, results, true) ?? draft;
    log(`INFO [nightGraphs.graphEvolve] tested ${redactKnown(JSON.stringify({ workflowId, draftId: recorded.id, draftVersion: recorded.version, cases: results.length, green: true }))}`);

    const failPublish = (reason: string) => {
      suiteMap.delete(workflowId); failedSuiteIds.add(workflowId);
      log(`WARN [nightGraphs.graphEvolve] publish_failed ${redactKnown(JSON.stringify({ workflowId, draftId: recorded.id, reason }))}`);
      outcomes.push({ workflowId, draftId: recorded.id, kind: diff.kind, status: "publish_failed", version: null, reason });
      rejectedCount += 1;
    };
    const matchedSkills = skillsByWf.get(workflowId) ?? [];
    const isLastOrdered = itemIdx === ordered.length - 1;
    if (matchedSkills.length > 0 || (!shouldPublish && isLastOrdered && supersededIds.length > 0)) {
      const stagedRes = await stageCompanionSkillsForDraft({
        db: deps.db, skillsRoot: skillsFn(), draftId: recorded.id, draftVersion: recorded.version, workflowId, operator,
        skills: matchedSkills, initialReads: initialSkillReads, supersededWorkflowIds: isLastOrdered || !shouldPublish ? supersededIds : [],
        deprojectize: deps.knownContext, log,
      });
      if (!stagedRes.ok) { failPublish(stagedRes.reason); continue; }
    }

    const titleRu = titleRuOf(candidate.name, workflowId), ownerProject = recorded.scope === "project" ? recorded.projectId : null;
    if (shouldPublish) {
      const unpubSkills = matchedSkills.filter((s) => !publishedSkillsInRun.has(s.skillId));
      const preErrors = unpubSkills.length ? await validateCompanionSkillCandidates(skillsFn(), unpubSkills, { deprojectize: deps.knownContext, log }) : [];
      if (preErrors.length > 0) { failPublish(preErrors.slice(0, 4).join("; ")); continue; }
      let publishedPath: string;
      let nextVer: number;
      if (deps.architect && !options?.publishApprovedSuite && candidates.length === 1) {
        const pub = await architect.publish({ projectId: recorded.projectId, draftId: recorded.id });
        if (!pub.published) { failPublish(String((pub as { reason?: unknown }).reason ?? "publish_failed")); continue; }
        const skillPub = await publishMatchedSkillsOrRollbackWf({ workflowDir: dirFn(), skillsRoot: skillsFn(), draftId: recorded.id, draftVersion: recorded.version, workflowId, operator, skills: matchedSkills, publishedInRun: publishedSkillsInRun, diskBase, writeAfterSha: null, deprojectize: deps.knownContext, log });
        if (!skillPub.ok) { failPublish(skillPub.reason); continue; }
        pendingPublishedEvents.push(...skillPub.events);
        publishedPath = String((pub as { path?: unknown }).path ?? workflowId);
        nextVer = Number((pub as { workflowVersion?: number }).workflowVersion ?? (Number(baseDef?.version ?? 1) + 1));
      } else {
        const reloaded = loadWorkflow(JSON.parse(JSON.stringify(fullLoaded.workflow)), { resolve: resolveSuite });
        const publishedWf = reloaded.ok ? reloaded.workflow : fullLoaded.workflow;
        const content = `${JSON.stringify(publishedWf, null, 2)}\n`;
        const write = await casWriteWorkflowFile(dirFn(), workflowId, content, diskBase?.sha256 ?? null);
        if (write.status !== "applied") { failPublish(write.reason ?? "file_conflict"); continue; }
        const writeAfterSha = write.afterSha256 ?? sha256Hex(content);
        const skillPub = await publishMatchedSkillsOrRollbackWf({ workflowDir: dirFn(), skillsRoot: skillsFn(), draftId: recorded.id, draftVersion: recorded.version, workflowId, operator, skills: matchedSkills, publishedInRun: publishedSkillsInRun, diskBase, writeAfterSha, deprojectize: deps.knownContext, log });
        if (!skillPub.ok) { failPublish(skillPub.reason); continue; }
        pendingPublishedEvents.push(...skillPub.events);
        const publishedSha = definitionSha256(publishedWf);
        createStatusResolver(deps.db as never).recordTest(publishedWf.id, publishedSha, true, results.map((r) => ({ caseId: r.caseId, green: r.green, path: r.path, failures: r.failures })), now());
        if (typeof drafts.markPublished === "function") drafts.markPublished(recorded.id, { version: recorded.version, path: write.path, sha256: writeAfterSha, workflowVersion: publishedWf.version });
        log(`INFO [nightGraphs.graphEvolve] test_receipt_recorded ${redactKnown(JSON.stringify({ workflowId, version: publishedWf.version, sha256: publishedSha }))}`);
        publishedPath = write.path;
        nextVer = publishedWf.version;
      }
      lastPublishedTarget = { draftId: recorded.id, draftVersion: recorded.version, workflowId, operator };
      if (candidate.sourceDeltaIds?.length) { citedAnyDelta = true; markTrajectoryDeltasProcessed(deps.db, candidate.sourceDeltaIds, now(), log); }
      const isPruneExisting = options?.operator === "prune_or_relax" && Boolean(baseDef);
      postOwnerItem(deps.db, {
        key: `workflow-evolved:${recorded.id}:v${nextVer}`, source: "night", kind: "workflow_evolved_digest", projectId: ownerProject, wake: false,
        what: baseDef ? `Граф «${titleRu}» (${workflowId}) автоматически обновлён до v${nextVer}` : `Граф «${titleRu}» (${workflowId}) опубликован как v${nextVer}`,
        why: isPruneExisting
          ? `Саморегулирующееся облегчение графа (prune_or_relax: ${diff.reasons.join(", ") || "упрощение и снятие избыточных ограничений"}) прошло фильтр депроектизации, lean-политику и все симуляции (${results.length}/${results.length}). Доступен откат в 1 клик.`
          : baseDef
            ? `Минорное ночное улучшение (${diff.reasons.join(", ") || "уточнение скиллов и проверок"}) прошло фильтр депроектизации и все симуляции (${results.length}/${results.length}). Доступен откат в 1 клик.`
            : `Одобренный сьют прошёл фильтр депроектизации, аудит и все симуляции (${results.length}/${results.length}). Доступен откат в 1 клик.`,
        evidence: [{ kind: "file", ref: publishedPath }],
        actions: [{ id: "rollback", label: "Откатить версию", cli: rpcLine("pilot_panel_rollback_workflow_draft", { draftId: recorded.id }), rpc: { method: "pilot_panel_rollback_workflow_draft", input: { draftId: recorded.id } } }],
      }, now());
      log(`INFO [nightGraphs.graphEvolve] auto_published ${redactKnown(JSON.stringify({ workflowId, draftId: recorded.id, version: nextVer }))}`);
      outcomes.push({ workflowId, draftId: recorded.id, kind: diff.kind, status: "auto_published", version: nextVer });
      publishedCount += 1;
    } else {
      if (!options?.publishApprovedSuite && candidate.sourceDeltaIds?.length) { citedAnyDelta = true; markTrajectoryDeltasProcessed(deps.db, candidate.sourceDeltaIds, now(), log); }
      postOwnerItem(deps.db, {
        key: `workflow-draft:${recorded.id}:v${recorded.version}`, source: "night", kind: "workflow_draft_proposed", projectId: ownerProject, wake: false,
        what: `Предложен ${baseDef ? "обновлённый" : "новый"} граф «${titleRu}» (${workflowId}, draft v${recorded.version})`,
        why: `Ночной синтез подготовил и проверил на стабах (${results.length}/${results.length} PASS) ${baseDef ? "структурное изменение" : "новый универсальный граф v1"}. Требуется подтверждение владельца перед публикацией.`,
        evidence: [{ kind: "text", ref: `${workflowId}#v${recorded.version}` }],
        actions: [{ id: "publish", label: "Опубликовать граф", cli: rpcLine("pilot_panel_publish_workflow_draft", { draftId: recorded.id }), rpc: { method: "pilot_panel_publish_workflow_draft", input: { draftId: recorded.id } } }],
      }, now());
      log(`INFO [nightGraphs.graphEvolve] proposed_tested ${redactKnown(JSON.stringify({ workflowId, draftId: recorded.id, draftVersion: recorded.version }))}`);
      outcomes.push({ workflowId, draftId: recorded.id, kind: diff.kind, status: "proposed_tested", version: recorded.version });
      proposedCount += 1;
    }
  }

  let supersededSnapshots: SupersededWorkflowSnapshot[] = [];
  if (rejectedCount === 0 && publishedCount > 0 && supersededIds.length > 0) {
    supersededSnapshots = await retireSupersededWorkflows(dirFn(), supersededIds, new Set(ordered.map((o) => o.workflowId)), log);
  }
  if (publishedCount > 0) {
    recordPublishedSkillEvolutionEvents({
      db: deps.db, events: pendingPublishedEvents,
      supersededWorkflowIds: rejectedCount === 0 ? supersededIds : [],
      supersededSnapshots, fallbackTarget: lastPublishedTarget, log,
    });
    deps.invalidateCatalog?.();
    if (operator === "prune_or_relax") {
      log(`INFO [nightGraphs.graphEvolve] prune_or_relax_applied ${redactKnown(JSON.stringify({ publishedCount, workflowIds: outcomes.filter((o) => o.status === "auto_published").map((o) => o.workflowId), skillIds: companionSkills.map((s) => s.skillId) }))}`);
    }
  }
  if (options?.deltaIds?.length && !citedAnyDelta && rejectedCount === 0 && (publishedCount > 0 || (!options?.publishApprovedSuite && proposedCount > 0))) {
    fixEvolveLog(log, "batch_mark_deltas", { count: options.deltaIds.length });
    markTrajectoryDeltasProcessed(deps.db, options.deltaIds, now(), log);
  }
  return { outcomes, publishedCount, proposedCount, rejectedCount, summary: `graph-evolve: ${publishedCount} auto-published, ${proposedCount} proposed, ${rejectedCount} rejected` };
}

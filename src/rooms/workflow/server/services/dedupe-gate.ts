import {
  DEFAULT_DEDUPE_THRESHOLD,
  createDraftStore,
  graphSignature,
  nearestByStructure,
  traceSignature,
  type DedupeCandidate,
  type RawDefinition,
  type StoredWorkflow,
  type Workflow,
} from "@lane-pilot/workflow-engine";
import type { LanePilotDatabase } from "../../../storage";
import { builtinWorkflows } from "../../builtin";

export type DedupeGateDecision = {
  id: string | null;
  score: number;
  threshold: number;
  outcome: "pass" | "near_twin";
  at: number;
};

export type DedupeGatePass = {
  ok: true;
  decision: DedupeGateDecision;
};

export type DedupeGateRefusal = {
  ok: false;
  reason: "near_twin";
  workflowId: string;
  score: number;
  threshold: number;
  outcome: "near_twin";
  decision: DedupeGateDecision;
};

export type DedupeGateResult = DedupeGatePass | DedupeGateRefusal;

export type DedupeCandidateInput = {
  id: string;
  status: string;
  scope?: "builtin" | "global" | "project";
  projectId?: string;
  internal?: boolean;
  definition?: Workflow | RawDefinition;
  sig?: ReadonlySet<string>;
};

export type DedupeGateOptions = {
  threshold?: number | (() => number | undefined);
  db?: LanePilotDatabase;
  loadLibraryWorkflows?: (input: {
    scope: "global" | "project";
    projectId: string;
  }) => Promise<readonly StoredWorkflow[] | readonly Workflow[]> | readonly StoredWorkflow[] | readonly Workflow[];
  extraCandidates?: readonly DedupeCandidateInput[];
  debug?: (message: string) => void;
};

export type DedupeCheckInput = {
  scope: "global" | "project";
  projectId: string;
  definition?: Workflow | RawDefinition;
  trace?: readonly string[];
  signature?: ReadonlySet<string>;
  exemptWorkflowId?: string;
};

function resolveThreshold(raw: number | (() => number | undefined) | undefined): number {
  const value = typeof raw === "function" ? raw() : raw;
  return typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_DEDUPE_THRESHOLD;
}

function inScope(
  origin: "builtin" | "global" | "project",
  candidateProjectId: string | undefined,
  targetScope: "global" | "project",
  targetProjectId: string,
): boolean {
  if (origin === "builtin" || origin === "global") return true;
  return targetScope === "project" && (!candidateProjectId || candidateProjectId === targetProjectId);
}

/** Structural deduplication gate before creating a workflow draft from a path, branch, template or evolve hypothesis. */
export function createDedupeGate(options: DedupeGateOptions = {}) {
  async function check(input: DedupeCheckInput): Promise<DedupeGateResult> {
    const threshold = resolveThreshold(options.threshold);
    const sig =
      input.signature ??
      (input.definition
        ? graphSignature(input.definition)
        : input.trace
          ? traceSignature(input.trace)
          : new Set<string>());

    const candidates: DedupeCandidate[] = [];
    const libraryItems = options.loadLibraryWorkflows
      ? await options.loadLibraryWorkflows({ scope: input.scope, projectId: input.projectId })
      : builtinWorkflows();

    for (const item of libraryItems) {
      const wf = "workflow" in item ? item.workflow : item;
      if (wf.status === "deprecated") continue;
      const origin = "origin" in item ? item.origin : wf.scope.level === "section" ? "project" : wf.scope.level;
      if (!inScope(origin, wf.scope.projectId, input.scope, input.projectId)) continue;
      if (input.exemptWorkflowId && wf.id === input.exemptWorkflowId) continue;
      const wfSig = graphSignature(wf);
      if (wfSig.size > 0) candidates.push({ id: wf.id, sig: wfSig, status: wf.status });
    }

    if (options.db) {
      const pending = createDraftStore(options.db).listEvolutionDrafts({
        scope: input.scope,
        ...(input.scope === "project" ? { projectId: input.projectId } : {}),
        status: ["draft", "tested"],
        limit: 200,
      });
      for (const draft of pending) {
        if (
          input.exemptWorkflowId &&
          (draft.workflowId === input.exemptWorkflowId || draft.metadata?.branchOf === input.exemptWorkflowId)
        ) {
          continue;
        }
        const draftSig = graphSignature(draft.definition);
        if (draftSig.size > 0) candidates.push({ id: draft.workflowId, sig: draftSig, status: draft.status });
      }
    }

    for (const extra of options.extraCandidates ?? []) {
      if (extra.status === "deprecated") continue;
      if (extra.scope && !inScope(extra.scope, extra.projectId, input.scope, input.projectId)) continue;
      if (input.exemptWorkflowId && extra.id === input.exemptWorkflowId) continue;
      const extraSig = extra.sig ?? (extra.definition ? graphSignature(extra.definition) : new Set<string>());
      if (extraSig.size > 0) candidates.push({ id: extra.id, sig: extraSig, status: extra.status });
    }

    const best = nearestByStructure(sig, candidates);
    const score = best ? best.score : 0;
    const nearTwin = best !== null && score >= threshold;
    const outcome = nearTwin ? "near_twin" : "pass";
    const at = Date.now();

    options.debug?.(`dedupe best=${best?.id ?? "none"} score=${score.toFixed(3)} threshold=${threshold} outcome=${outcome}`);

    if (nearTwin) {
      return {
        ok: false,
        reason: "near_twin",
        workflowId: best.id,
        score,
        threshold,
        outcome: "near_twin",
        decision: { id: best.id, score, threshold, outcome: "near_twin", at },
      };
    }

    return {
      ok: true,
      decision: { id: best?.id ?? null, score, threshold, outcome: "pass", at },
    };
  }

  return { check };
}

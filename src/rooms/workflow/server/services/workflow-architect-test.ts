import { replayCasesFromRuns, runDraftTest, testCasesOf } from "@lane-pilot/workflow-engine";
import type { DraftTestResult, ReplayCase, Workflow } from "@lane-pilot/workflow-engine";
import { HARNESS_VERSION, type DraftRow, type DraftStore, type LanePilotDatabase } from "../../../storage";
import { ToolError } from "../../../contracts/server";

export type ArchitectTestFromRuns = {
  workflowId?: string;
  limit?: number;
  runIds?: string[];
  allowCrossWorkflow?: boolean;
  pastLimit?: number;
};

/** Derives replay run filters from a draft's `branchOf` / `sourceRunIds` metadata when `fromRuns` is not explicit. */
export function resolveDraftTestFromRuns(
  draft: Pick<DraftRow, "metadata">,
  explicit?: ArchitectTestFromRuns,
): ArchitectTestFromRuns | undefined {
  if (explicit) return explicit;
  const sourceRunIds = Array.isArray(draft.metadata?.sourceRunIds)
    ? draft.metadata.sourceRunIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : [];
  const branchOf = typeof draft.metadata?.branchOf === "string" && draft.metadata.branchOf.trim()
    ? draft.metadata.branchOf.trim()
    : null;
  if (branchOf) {
    return {
      workflowId: branchOf,
      ...(sourceRunIds.length ? { runIds: sourceRunIds, allowCrossWorkflow: true } : {}),
      pastLimit: 20,
    };
  }
  return sourceRunIds.length ? { runIds: sourceRunIds, allowCrossWorkflow: true } : undefined;
}

export type ArchitectTestInput = {
  draft: DraftRow;
  workflow: Workflow;
  resolve: (id: string, version?: number) => Workflow | null;
  db: LanePilotDatabase;
  drafts: DraftStore;
  debugLog: (message: string) => void;
  changed: (draft: DraftRow, threadId?: string) => void;
  threadId?: string;
  testCaseId?: string;
  fromRuns?: ArchitectTestFromRuns;
};

/** Executes a draft's `test.sim` cases and optional past-run replay cases, persisting test state on the draft. */
export async function runArchitectDraftTests(input: ArchitectTestInput) {
  const { draft, workflow, resolve, db, drafts, debugLog, changed } = input;
  let replay: ReplayCase[] | undefined;
  if (input.fromRuns) {
    const targetWorkflowId = input.fromRuns.workflowId ?? workflow.id;
    const collected: ReplayCase[] = [];
    const seenRunIds = new Set<string>();
    const pushCases = (list: readonly ReplayCase[]) => {
      for (const item of list) {
        if (seenRunIds.has(item.runId)) continue;
        seenRunIds.add(item.runId);
        collected.push(item);
      }
    };
    if (input.fromRuns.runIds !== undefined) {
      pushCases(
        replayCasesFromRuns(db, targetWorkflowId, {
          runIds: input.fromRuns.runIds,
          ...(input.fromRuns.allowCrossWorkflow ? { allowCrossWorkflow: true } : {}),
          workflow,
          log: { debug: debugLog },
        }).cases,
      );
    }
    if (input.fromRuns.limit !== undefined || input.fromRuns.pastLimit !== undefined) {
      pushCases(
        replayCasesFromRuns(db, targetWorkflowId, {
          limit: input.fromRuns.pastLimit ?? input.fromRuns.limit,
          workflow,
          log: { debug: debugLog },
        }).cases,
      );
    }
    replay = collected;
  }
  const cases = testCasesOf(workflow, replay ? { cases: replay } : undefined);
  const selected = input.testCaseId ? cases.filter((item) => item.id === input.testCaseId) : cases;
  if (!selected.length) {
    throw new ToolError(`no test case "${input.testCaseId}"; the draft has: ${cases.map((item) => item.id).join(", ")}`, {
      code: "not_found",
      retryable: false,
      sideEffects: "none",
    });
  }
  const results: DraftTestResult[] = [];
  for (const testCase of selected) {
    results.push(await runDraftTest({ db, harnessVersion: HARNESS_VERSION, resolveWorkflow: resolve, log: { debug: debugLog } }, workflow, testCase));
  }
  // A single case merges into the earlier results of this version; the draft is «tested» only when every case has run and is green.
  const earlier = draft.tests?.version === draft.version ? draft.tests.results.filter((row) => !results.some((fresh) => fresh.caseId === row.caseId)) : [];
  const merged = [...earlier, ...results].filter((row) => cases.some((item) => item.id === row.caseId));
  const complete = cases.every((item) => merged.some((row) => row.caseId === item.id));
  const recorded = drafts.recordTests(draft.id, draft.version, merged, complete) ?? draft;
  changed(recorded, input.threadId);
  const green = results.every((row) => row.green);
  return {
    draftId: draft.id, version: draft.version, ran: true, green, status: recorded.status, allCasesRun: complete,
    cases: results.map((row) => ({
      caseId: row.caseId, green: row.green, status: row.status, reason: row.reason, path: row.path, output: row.output, failures: row.failures, runId: row.runId, failedNode: row.failedNode,
      ...(row.nodeId !== undefined ? { nodeId: row.nodeId } : {}),
      stubbedCalls: row.stubbed.map((call) => `${call.node} (${call.type}${call.executor !== call.type ? `: ${call.executor}` : ""})`),
      ...(row.notChecked.length ? { notChecked: row.notChecked } : {}),
    })),
    note: "agents, code tasks and actions ran on stubs: nothing was sent, searched or changed outside",
    next: !green ? "read the failures, fix the draft or the case with lane_pilot_workflow_draft, action patch, test again"
      : complete ? "all cases are green: show the owner the result, then lane_pilot_workflow_draft, action publish" : "this case is green; run the others (lane_pilot_workflow_draft, action test without testCaseId) before publishing",
  };
}

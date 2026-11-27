import { sha256Hex } from "@lane-pilot/kit";
import {
  branchCandidateKey,
  listRunIdsByWorkflowAndThreads,
  listStepCostsByRunIds,
  listWfRunsByIdsOrdered,
} from "@lane-pilot/workflow-engine";
import { errandTitle, routeConfidence } from "../../../errands";
import { listTrajectoryDeltasInWindow } from "../../../errands/server";
import { listErrandEpisodesInWindow, type LanePilotDatabase } from "../../../storage";
import { listRouteMisses } from "../../../workflow/server";
import {
  DEFAULT_PATHS_BRANCH_DRAFT_REPEATS,
  DEFAULT_PATHS_BRANCH_WINDOW_DAYS,
} from "../../settings";

const DAY_MS = 86_400_000;

export type Candidate = {
  key: string;
  label: string;
  kind: "free" | "branch";
  count: number;
  lastSeen: number;
  costMicroUsd: number;
  runIds: string[];
  graphId?: string;
  ready: boolean;
};

export type PathCandidatesLog = {
  debug?: ((message: string) => void) | undefined;
  warn?: ((message: string) => void) | undefined;
};

export type ListPathCandidatesInput = {
  now?: number;
  windowDays?: number;
  repeats?: number;
  projectId?: string | null;
  log?: PathCandidatesLog;
};

export type PathCandidateEntry = {
  candidate: Candidate;
  projectIds: string[];
  samples: string[];
};

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const rankScore = (candidate: Candidate): number => candidate.count * Math.max(candidate.costMicroUsd, 1);

const compareEntries = (a: PathCandidateEntry, b: PathCandidateEntry): number =>
  rankScore(b.candidate) - rankScore(a.candidate)
  || b.candidate.lastSeen - a.candidate.lastSeen
  || a.candidate.key.localeCompare(b.candidate.key);

/**
 * Discovers ranked free-work and branch candidates from episodes, catalog route misses,
 * and trajectory deltas within the configured window.
 */
export function listPathCandidateEntries(
  db: LanePilotDatabase,
  input: ListPathCandidatesInput = {},
  filter?: { allowProject?: (projectId: string | null) => boolean },
): { free: PathCandidateEntry[]; branch: PathCandidateEntry[] } {
  const now = input.now ?? Date.now();
  const windowDays = Math.max(1, Math.round(input.windowDays ?? DEFAULT_PATHS_BRANCH_WINDOW_DAYS));
  const repeats = Math.max(1, Math.round(input.repeats ?? DEFAULT_PATHS_BRANCH_DRAFT_REPEATS));
  const since = now - windowDays * DAY_MS;
  const projectId = input.projectId?.trim() || null;
  const allowProject = (pid: string | null) => (filter?.allowProject ? filter.allowProject(pid) : true);

  const freeGroups = new Map<string, {
    key: string;
    label: string;
    count: number;
    lastSeen: number;
    costMicroUsd: number;
    runIds: string[];
    runSeen: Set<string>;
    projectIds: string[];
    projectSeen: Set<string>;
    samples: string[];
  }>();

  const touchFree = (
    key: string,
    item: {
      label: string;
      at: number;
      costMicroUsd: number;
      runId?: string;
      projectId: string | null;
      sample?: string;
    },
  ) => {
    let group = freeGroups.get(key);
    if (!group) {
      group = {
        key,
        label: item.label,
        count: 0,
        lastSeen: item.at,
        costMicroUsd: 0,
        runIds: [],
        runSeen: new Set(),
        projectIds: [],
        projectSeen: new Set(),
        samples: [],
      };
      freeGroups.set(key, group);
    }
    group.count += 1;
    if (item.at >= group.lastSeen) {
      group.lastSeen = item.at;
      if (item.label) group.label = item.label;
    }
    group.costMicroUsd += item.costMicroUsd;
    if (item.runId && !group.runSeen.has(item.runId)) {
      group.runSeen.add(item.runId);
      group.runIds.push(item.runId);
    }
    if (item.projectId && !group.projectSeen.has(item.projectId)) {
      group.projectSeen.add(item.projectId);
      group.projectIds.push(item.projectId);
    }
    if (item.sample && group.samples.length < 3 && !group.samples.includes(item.sample)) {
      group.samples.push(item.sample);
    }
  };

  try {
    const episodes = listErrandEpisodesInWindow(db, { since, projectId })
      .filter((ep) => allowProject(ep.projectId));
    if (episodes.length > 0) {
      const runIds = episodes.map((ep) => ep.runId);
      const runs = listWfRunsByIdsOrdered(db as never, runIds, projectId);
      const runById = new Map(runs.map((run) => [run.id, run]));
      const stepCosts = listStepCostsByRunIds(db as never, runIds);

      for (const ep of episodes) {
        const run = runById.get(ep.runId);
        const inputs = parseJsonObject(run?.inputs_json);
        const routeTop = typeof inputs.routeTop === "string" ? inputs.routeTop.trim() : "";
        const conf = routeTop ? routeConfidence(routeTop) : Number.NaN;
        const withoutMatch = ep.workflowId === "errand" || (Number.isFinite(conf) && conf < 90);
        if (!withoutMatch) continue;

        const traceText = ep.traceJson?.trim() ?? "";
        const hasTrace = Boolean(traceText && traceText !== "[]");
        const key = ep.processKey
          ? `free:process:${ep.processKey}`
          : hasTrace
            ? `free:trace:${sha256Hex(traceText)}`
            : `free:run:${ep.runId}`;

        const title = errandTitle(inputs);
        const summary = parseJsonObject(ep.summaryJson);
        const summaryGoal = typeof summary.goal === "string" ? summary.goal.trim() : "";
        const label = ep.processKey
          || (title !== "—" ? title : "")
          || summaryGoal
          || (hasTrace ? `trace:${sha256Hex(traceText).slice(0, 12)}` : ep.runId);

        const stepCost = stepCosts.get(ep.runId);
        const costMicroUsd = stepCost?.hasSteps ? stepCost.costMicroUsd : (run?.cost_micro_usd ?? 0);
        const at = Math.max(ep.updatedAt, ep.createdAt);
        touchFree(key, {
          label,
          at,
          costMicroUsd,
          runId: ep.runId,
          projectId: ep.projectId,
          sample: title !== "—" ? title : label,
        });
      }
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    input.log?.warn?.(`path candidates source failed source=episodes: ${message}`);
  }

  try {
    const misses = listRouteMisses(db as never, { since, ...(projectId ? { projectId } : {}), limit: 2000 })
      .filter((miss) => allowProject(miss.projectId));
    for (const miss of misses) {
      const key = `free:miss:${miss.briefHash}`;
      const label = miss.briefExcerpt.trim() || `miss:${miss.briefHash.slice(0, 12)}`;
      touchFree(key, {
        label,
        at: miss.createdAt,
        costMicroUsd: 0,
        projectId: miss.projectId,
        sample: label,
      });
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    input.log?.warn?.(`path candidates source failed source=misses: ${message}`);
  }

  const branchEntries: PathCandidateEntry[] = [];
  try {
    const deltas = listTrajectoryDeltasInWindow(db as never, { since, projectId, onlyAccepted: true, limit: 2000 })
      .filter((delta) => allowProject(delta.projectId) && Boolean(delta.workflowId?.trim()));
    const branchGroups = new Map<string, {
      key: string;
      graphId: string;
      kind: string;
      label: string;
      count: number;
      lastSeen: number;
      threadIds: Set<string>;
      projectIds: string[];
      projectSeen: Set<string>;
    }>();

    for (const delta of deltas) {
      const graphId = delta.workflowId!.trim();
      const key = branchCandidateKey({
        graphId,
        interventionKind: delta.interventionKind,
        maskedSummary: delta.maskedSummary,
        stageArchetype: delta.stageArchetype,
      });
      let group = branchGroups.get(key);
      if (!group) {
        group = {
          key,
          graphId,
          kind: delta.interventionKind,
          label: `${graphId}: ${delta.interventionKind} — ${delta.maskedSummary.slice(0, 120)}`,
          count: 0,
          lastSeen: delta.createdAt,
          threadIds: new Set(),
          projectIds: [],
          projectSeen: new Set(),
        };
        branchGroups.set(key, group);
      }
      group.count += 1;
      if (delta.createdAt >= group.lastSeen) {
        group.lastSeen = delta.createdAt;
        group.label = `${graphId}: ${delta.interventionKind} — ${delta.maskedSummary.slice(0, 120)}`;
      }
      if (delta.threadId) group.threadIds.add(delta.threadId);
      if (delta.projectId && !group.projectSeen.has(delta.projectId)) {
        group.projectSeen.add(delta.projectId);
        group.projectIds.push(delta.projectId);
      }
    }

    for (const group of branchGroups.values()) {
      let runIds: string[] = [];
      let costMicroUsd = 0;
      if (group.threadIds.size > 0) {
        try {
          runIds = listRunIdsByWorkflowAndThreads(db as never, group.graphId, [...group.threadIds]);
          if (runIds.length > 0) {
            const stepCosts = listStepCostsByRunIds(db as never, runIds);
            for (const runId of runIds) {
              costMicroUsd += stepCosts.get(runId)?.costMicroUsd ?? 0;
            }
          }
        } catch {
          runIds = [];
          costMicroUsd = 0;
        }
      }
      branchEntries.push({
        candidate: {
          key: group.key,
          label: group.label,
          kind: "branch",
          count: group.count,
          lastSeen: group.lastSeen,
          costMicroUsd,
          runIds,
          graphId: group.graphId,
          ready: group.count >= repeats,
        },
        projectIds: group.projectIds,
        samples: [group.label],
      });
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    input.log?.warn?.(`path candidates source failed source=deltas: ${message}`);
  }

  const freeEntries: PathCandidateEntry[] = [...freeGroups.values()].map((group) => ({
    candidate: {
      key: group.key,
      label: group.label,
      kind: "free",
      count: group.count,
      lastSeen: group.lastSeen,
      costMicroUsd: group.costMicroUsd,
      runIds: group.runIds,
      ready: false,
    },
    projectIds: group.projectIds,
    samples: group.samples,
  }));

  freeEntries.sort(compareEntries);
  branchEntries.sort(compareEntries);

  const readyCount = branchEntries.filter((entry) => entry.candidate.ready).length;
  input.log?.debug?.(`path candidates free=${freeEntries.length} branch=${branchEntries.length} ready=${readyCount}`);

  return { free: freeEntries, branch: branchEntries };
}

/** Lists ranked free-work and branch candidates in the given rolling window. */
export function listPathCandidates(
  db: LanePilotDatabase,
  input: ListPathCandidatesInput = {},
): { free: Candidate[]; branch: Candidate[] } {
  const { free, branch } = listPathCandidateEntries(db, input);
  return {
    free: free.map((entry) => entry.candidate),
    branch: branch.map((entry) => entry.candidate),
  };
}

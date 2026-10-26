import { TASK_KINDS } from "../contracts";
import { mapVerificationCwd } from "../tasks";
import type { AttemptMetrics } from "../usage/server";
import { q, realClock, type BenchProjectRef, type Clock, type HostPort, type PipelinePort } from "./ports";
import {
  addSpent, finishRunRow, getRun, getSet, listResults, listRuns, saveResult, startRunRow, verifySet, type BenchDb, type BenchResult, type BenchRun,
} from "./store";
import { BENCH_PROJECT_PREFIX, BENCH_PROJECTS, benchProjectName, type ManifestTask, type VerificationItem } from "./types";
import { MIN_FREE_GB, freeGb, linkDependenciesCommand } from "./warmup";

/**
 * A series on the bench (SMA plan P0-1): the SAME contracts of a set, through the normal pipeline, on one arm. Memory and rules are
 * frozen by construction: the sandbox project «LP bench …» is a new project with no memory and no rules of its own, its memory
 * settings are off, and every task gets an area no earlier task shares (so no area history from another arm reaches a writer).
 * What comes out per task is read from `lp_attempt_metrics` and the attempt's state; no model judges it.
 */
export type Fault = "owns" | "read_first";

export type SeriesInput = {
  version: string;
  arm: string;
  repeat?: number;
  /** The first N tasks of the set (it is interleaved, so they are a mix). */
  limit?: number;
  only?: readonly string[];
  writer?: { providerId: string; model: string };
  /** `none` (default), `tree` (the project's own active tree for the task's area) or a harness id. */
  harness?: string;
  /** The arm's own project settings (`plan_critique.enabled: true` ...). */
  settings?: Record<string, unknown>;
  /** A deliberately broken arm: the series must come out worse than the baseline. */
  fault?: Fault;
  budgetTokens?: number;
  budgetHours?: number;
  taskTimeoutMin?: number;
  pollMs?: number;
  minFreeGb?: number;
};

export type RunnerDeps = {
  db: BenchDb;
  host: HostPort;
  pipeline: PipelinePort;
  clock?: Clock;
  log?: (line: string) => void;
  /** The «LP bench …» project name for a manifest task (default: benchProjectName(project, repo)). */
  projectNameFor?: (task: ManifestTask) => string;
};

export const DEFAULT_BUDGET_TOKENS = 120_000_000;
export const DEFAULT_BUDGET_HOURS = 6;
export const DEFAULT_TASK_TIMEOUT_MIN = 40;
/** The first runs go to a cheap writer (owner decision 2026-10-22); an arm that names no writer gets this one, not what the previous arm left in the project. */
export const DEFAULT_BENCH_WRITER = { providerId: "codex", model: "gpt-6-luna" } as const;

const slug = (text: string, max: number): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max) || "arm";

/** «LP bench SelfyStudio»; a project with several repositories gets the repository's folder name too («LP bench BB-сервис / bb-plugin-lane-pilot»). */
export function defaultProjectName(task: ManifestTask): string {
  const entry = BENCH_PROJECTS.find((project) => project.projectId === task.projectId);
  const single = entry && entry.cwdPrefixes.length === 1 && !entry.cwdPrefixes[0]!.endsWith("/");
  return single ? benchProjectName(task.projectName) : benchProjectName(`${task.projectName} / ${task.repoPath.split("/").filter(Boolean).pop() ?? ""}`);
}

/** The contract as the bench dispatches it: the same task, moved to the clone, with an id and an area of its own. */
export function benchContract(task: ManifestTask, input: { version: string; arm: string; repeat: number; root: string; fault?: Fault | undefined; /** The `read_first` files that exist at the task's base commit (the lint refuses a missing one); all when absent. */ readFirst?: readonly string[] }): Record<string, unknown> {
  const contract = JSON.parse(JSON.stringify(task.contract)) as Record<string, unknown>;
  const id = `bench-${input.version}-${slug(input.arm, 36)}-r${input.repeat}-${String(task.position).padStart(2, "0")}`;
  const verification = (contract.verification as VerificationItem[]).map((item) => ({ ...item, cwd: mapVerificationCwd(item.cwd, task.repoPath, input.root) ?? input.root }));
  const area = typeof contract.area === "string" && contract.area ? `${contract.area.slice(0, 80)}~b${task.position}${slug(input.arm, 12)}r${input.repeat}` : `bench~b${task.position}${slug(input.arm, 12)}r${input.repeat}`;
  const next: Record<string, unknown> = { ...contract, id, project_cwd: input.root, verification, area, depends_on: [] };
  // Contracts stored before the task standard (display_title, kind) would be refused by today's lint: they get the two fields the same way on every arm.
  const title = String(contract.title ?? task.taskId).replace(/\s+/g, " ").trim();
  if (typeof contract.display_title !== "string" || !contract.display_title.trim()) next.display_title = title.length > 60 ? `${title.slice(0, 59)}…` : title;
  if (!(TASK_KINDS as readonly unknown[]).includes(contract.kind)) next.kind = "feature";
  if (input.readFirst) next.read_first = [...input.readFirst];
  if (input.fault === "owns") { next.expected_outputs = ["bench-fault/unrelated.txt"]; next.owns_paths = ["bench-fault/"]; }
  if (input.fault === "read_first") next.read_first = ["package.json"];
  return next;
}

/** Sums what the attempts of one task cost and how far they got. A rejected spawn started no writer and cost nothing. */
export function aggregateAttempts(attempts: readonly AttemptMetrics[]): Pick<BenchResult, "attempts" | "stagesPassed" | "stagesFailed" | "tokens" | "costUsd" | "costState" | "seconds"> {
  const billed = attempts.filter((row) => row.writer.threadId);
  const measured = billed.filter((row) => row.costState === "measured");
  const costState = !billed.length || measured.length === billed.length ? (billed.length ? "measured" : "not_measured") : measured.length || billed.some((row) => row.costState === "partial") ? "partial" : "not_measured";
  const timed = attempts.filter((row) => row.seconds !== null);
  return {
    attempts: attempts.length,
    stagesPassed: attempts.reduce((sum, row) => sum + row.stagesPassed, 0), stagesFailed: attempts.reduce((sum, row) => sum + row.stagesFailed, 0),
    tokens: costState === "measured" ? measured.reduce((sum, row) => sum + (row.tokens?.total ?? 0), 0) : null,
    costUsd: costState === "measured" ? measured.reduce((sum, row) => sum + (row.costUsd ?? 0), 0) : null,
    costState,
    seconds: timed.length ? timed.reduce((sum, row) => sum + (row.seconds as number), 0) : null,
  };
}

/** The paths of `wanted` that exist in the clone (relative paths, or absolute ones inside the original checkout). */
async function existingFiles(host: HostPort, project: BenchProjectRef, task: ManifestTask, wanted: readonly string[]): Promise<string[]> {
  const probe = wanted.map((item) => `[ -e ${q(mapVerificationCwd(item, task.repoPath, project.path) ?? item)} ] && echo ${q(item)}`).join("; ");
  const result = await host.run(project.hostId, project.path, `${probe}; true`, 60).catch(() => null);
  const found = new Set((result?.stdout ?? "").split("\n").map((line) => line.trim()).filter(Boolean));
  return wanted.filter((item) => found.has(item));
}

export type SeriesReport = {
  version: string; arm: string; repeat: number; state: BenchRun["state"]; stopReason: string | null;
  tasks: number; ran: number; accepted: number; skipped: number; spentTokens: number; seconds: number;
};

/** Resets the clone to the task's base commit: the only checkout the pipeline works from for this series. */
export function prepareCheckoutCommand(repo: string, path: string, sha: string): string {
  return [
    `{ [ -d ${q(`${path}/.git`)} ] || { mkdir -p ${q(path)} && git clone -q --local ${q(repo)} ${q(`${path}.clone`)} && cp -a ${q(`${path}.clone`)}/. ${q(path)}/ && rm -rf ${q(`${path}.clone`)}; }; }`,
    `cd ${q(path)}`,
    `{ git cat-file -e ${q(`${sha}^{commit}`)} 2>/dev/null || git fetch -q ${q(repo)} ${q(sha)}; }`,
    `git checkout -q -f -B lp-bench ${q(sha)}`,
    `git clean -fdq -e node_modules`,
    `{ grep -qx node_modules .git/info/exclude 2>/dev/null || printf 'node_modules\\n' >> .git/info/exclude; }`,
    linkDependenciesCommand(repo, path),
  ].join(" && ");
}

export async function runSeries(deps: RunnerDeps, input: SeriesInput): Promise<SeriesReport> {
  const clock = deps.clock ?? realClock, log = deps.log ?? (() => undefined);
  const repeat = input.repeat ?? 1;
  const set = getSet(deps.db, input.version);
  if (!set) throw new Error(`no bench set ${input.version}; build it with: bb lane-pilot bench build --set ${input.version}`);
  const sound = verifySet(set);
  if (!sound.ok) throw new Error(`bench set ${input.version} was changed after it was written: ${sound.reason}`);
  let tasks = set.tasks.filter((task) => !input.only || input.only.includes(task.taskId));
  if (input.limit !== undefined) tasks = tasks.slice(0, input.limit);
  if (!tasks.length) throw new Error("no task selected");

  const budgetTokens = input.budgetTokens ?? DEFAULT_BUDGET_TOKENS, budgetHours = input.budgetHours ?? DEFAULT_BUDGET_HOURS;
  const config = { writer: input.writer ?? DEFAULT_BENCH_WRITER, harness: input.harness ?? "none", settings: input.settings ?? {}, fault: input.fault ?? null };
  const run = startRunRow(deps.db, { setId: set.id, arm: input.arm, repeat, config, budgetTokens, budgetHours });
  const done = new Set(listResults(deps.db, run.id).filter((row) => row.state !== "skipped_budget" && row.state !== "error").map((row) => row.taskId));

  // What this arm has already used (all its repeats): the cap is per arm.
  const armRuns = listRuns(deps.db, set.id).filter((row) => row.arm === input.arm);
  const armResults = () => armRuns.flatMap((row) => listResults(deps.db, row.id)).filter((row) => row.state !== "skipped_budget");
  let stopReason: string | null = null;

  const free = async (hostId: string): Promise<number | null> => freeGb(deps.host, hostId);
  const groups = new Map<string, ManifestTask[]>();
  for (const task of tasks) groups.set(task.repoPath, [...(groups.get(task.repoPath) ?? []), task]);

  const runGroup = async (repo: string, list: ManifestTask[]): Promise<void> => {
    const name = (deps.projectNameFor ?? defaultProjectName)(list[0]!);
    const project: BenchProjectRef | null = await deps.pipeline.findProject(name);
    if (!project) {
      const reason = `no BB project named «${name}»: create it with bb project create --name ${q(name)} --root <folder on ${list[0]!.hostId}> --machine ${list[0]!.hostId}`;
      for (const task of list) if (!done.has(task.taskId)) saveResult(deps.db, { runId: run.id, taskId: task.taskId, position: task.position, state: "error", accepted: false, benchTaskId: null, lpRunId: null, attempts: 0, stagesPassed: 0, stagesFailed: 0, tokens: null, costUsd: null, costState: "not_measured", seconds: null, reason, recordedAt: clock.now() });
      stopReason = stopReason ?? reason;
      return;
    }
    // «LP sandbox …» is accepted too: a plugin older than the bench only knows that prefix as sandbox traffic (see scripts/lp-bench.ts).
    if (!project.name.startsWith(BENCH_PROJECT_PREFIX) && !project.name.startsWith("LP sandbox")) throw new Error(`refusing to run in «${project.name}»: a bench project's name starts with «${BENCH_PROJECT_PREFIX}»`);
    const settings: Record<string, unknown> = {
      "writer.rotation_share": 0, "writer.provider": (input.writer ?? DEFAULT_BENCH_WRITER).providerId, "writer.model": (input.writer ?? DEFAULT_BENCH_WRITER).model,
      "memory.enabled": false, "memory.inject": false, "memory.maintain": false,
      "plan_critique.enabled": false, "code_critique.enabled": false, "browser_qa.enabled": false,
      ...(input.settings ?? {}),
    };
    // A project that sets code_critique.enabled itself keeps its choice, so the `false` above would make an arm's critic.code.default_for_risk dead letter (quality-mode.ts): leave it unset for such an arm.
    if (input.settings && "critic.code.default_for_risk" in input.settings && !("code_critique.enabled" in input.settings)) delete settings["code_critique.enabled"];
    await deps.pipeline.configure(project, { settings, harness: input.harness ?? "none", sourceProjectId: list[0]!.projectId });
    let lp: { pmThreadId: string; runId: string } | null = null;
    try {
      for (const task of list) {
        if (done.has(task.taskId) || stopReason) continue;
        // Stop BEFORE the cap: the next task is expected to cost what the finished ones did on average.
        const finished = [...armResults(), ...listResults(deps.db, run.id)].filter((row, index, all) => all.findIndex((other) => other.runId === row.runId && other.taskId === row.taskId) === index);
        const spentTokens = finished.reduce((sum, row) => sum + (row.tokens ?? 0), 0), spentSeconds = finished.reduce((sum, row) => sum + (row.seconds ?? 0), 0);
        const avgTokens = finished.filter((row) => row.tokens !== null).length ? spentTokens / finished.filter((row) => row.tokens !== null).length : 0;
        const avgSeconds = finished.filter((row) => row.seconds !== null).length ? spentSeconds / finished.filter((row) => row.seconds !== null).length : 0;
        if (spentTokens + avgTokens > budgetTokens) { stopReason = `token budget: ${Math.round(spentTokens)} used of ${budgetTokens}, the next task is expected to take ${Math.round(avgTokens)}`; break; }
        if ((spentSeconds + avgSeconds) / 3600 > budgetHours) { stopReason = `time budget: ${(spentSeconds / 3600).toFixed(2)} h used of ${budgetHours}, the next task is expected to take ${(avgSeconds / 3600).toFixed(2)} h`; break; }
        const minFree = input.minFreeGb ?? MIN_FREE_GB;
        const space = await free(project.hostId);
        if (space !== null && space < minFree) { stopReason = `host ${project.hostId} has ${space} GB free, below ${minFree}`; break; }

        const prepared = await deps.host.run(project.hostId, "/", prepareCheckoutCommand(task.repoPath, project.path, task.initialHeadSha), 900);
        if (prepared.exitCode !== 0) {
          saveResult(deps.db, { runId: run.id, taskId: task.taskId, position: task.position, state: "error", accepted: false, benchTaskId: null, lpRunId: null, attempts: 0, stagesPassed: 0, stagesFailed: 0, tokens: null, costUsd: null, costState: "not_measured", seconds: null, reason: `checkout failed: ${(prepared.stderr || prepared.stdout).trim().slice(-300)}`, recordedAt: clock.now() });
          continue;
        }
        if (!lp) lp = await deps.pipeline.startRun(project);
        // A file the live checkout had untracked (a plan, a spec) is not in the clone at the base commit: the lint would refuse the task, so it is left out of read_first, on every arm alike.
        const wanted = Array.isArray(task.contract.read_first) ? (task.contract.read_first as unknown[]).filter((item): item is string => typeof item === "string") : [];
        const present = wanted.length ? await existingFiles(deps.host, project, task, wanted) : [];
        if (present.length < wanted.length) log(`bench ${input.arm} r${repeat}: ${task.taskId}: read_first without ${wanted.filter((item) => !present.includes(item)).join(", ")} (not in the base commit)`);
        const contract = benchContract(task, { version: set.version, arm: input.arm, repeat, root: project.path, fault: input.fault, readFirst: present });
        let benchTaskId = String(contract.id);
        log(`bench ${input.arm} r${repeat}: dispatching ${benchTaskId} (${task.taskId}, ${task.stratum}, ${task.risk}${task.hard ? ", hard" : ""})`);
        const sent = await deps.pipeline.dispatch(project, lp.pmThreadId, contract);
        if (sent.taskId) benchTaskId = sent.taskId;
        let outcome = { latestState: null as string | null, attempts: 0 };
        let reason: string | null = null;
        if (!sent.ok) { reason = `dispatch refused: ${sent.detail.slice(0, 600)}`; log(`bench ${input.arm} r${repeat}: ${benchTaskId} ${reason.slice(0, 300)}`); }
        else {
          const deadline = clock.now() + (input.taskTimeoutMin ?? DEFAULT_TASK_TIMEOUT_MIN) * 60_000;
          let settled = 0;
          while (clock.now() < deadline) {
            outcome = await deps.pipeline.outcome(lp.runId, benchTaskId).catch(() => outcome);
            const terminal = outcome.latestState === "accepted" || outcome.latestState === "blocked" || outcome.latestState === "canceled";
            settled = terminal ? settled + 1 : 0;
            if (settled >= 2) break;
            await clock.sleep(input.pollMs ?? 20_000);
          }
          if (settled < 2) { reason = `no end after ${input.taskTimeoutMin ?? DEFAULT_TASK_TIMEOUT_MIN} min; cancelled`; await deps.pipeline.cancel(lp.runId, benchTaskId).catch(() => undefined); }
        }
        const attempts = sent.ok ? await deps.pipeline.metrics(project, lp.runId, benchTaskId).catch(() => [] as AttemptMetrics[]) : [];
        const accepted = outcome.latestState === "accepted";
        const sums = aggregateAttempts(attempts);
        saveResult(deps.db, {
          runId: run.id, taskId: task.taskId, position: task.position, state: reason && !sent.ok ? "error" : accepted ? "accepted" : "not_accepted", accepted,
          benchTaskId, lpRunId: lp.runId, ...sums, reason: reason ?? (accepted ? null : `ended ${outcome.latestState ?? "without an attempt"}`), recordedAt: clock.now(),
        }, attempts);
        if (sums.tokens) addSpent(deps.db, run.id, sums.tokens);
        log(`bench ${input.arm} r${repeat}: ${benchTaskId} ${accepted ? "accepted" : "not accepted"}, ${sums.attempts} attempts, stages ${sums.stagesPassed}, cost ${sums.costUsd === null ? "not measured" : `$${sums.costUsd.toFixed(3)}`}, ${sums.seconds ?? "?"}s`);
      }
    } finally {
      if (lp) await deps.pipeline.finishRun(project, lp.runId).catch((cause: unknown) => log(`bench: could not finish run ${lp?.runId}: ${cause instanceof Error ? cause.message : String(cause)}`));
    }
  };

  // Repositories on different machines go side by side; one repository's tasks run one after the other (one clone, one base at a time).
  const failures: string[] = [];
  await Promise.all([...groups.entries()].map(([repo, list]) => runGroup(repo, list).catch((cause: unknown) => { const text = cause instanceof Error ? cause.message : String(cause); failures.push(text); log(`bench ${input.arm} r${repeat}: ${repo.split("/").pop()} stopped: ${text.slice(0, 400)}`); })));

  const results = listResults(deps.db, run.id);
  const have = new Set(results.map((row) => row.taskId));
  for (const task of tasks) if (!have.has(task.taskId)) saveResult(deps.db, { runId: run.id, taskId: task.taskId, position: task.position, state: "skipped_budget", accepted: false, benchTaskId: null, lpRunId: null, attempts: 0, stagesPassed: 0, stagesFailed: 0, tokens: null, costUsd: null, costState: "not_measured", seconds: null, reason: stopReason ?? "not run", recordedAt: clock.now() });
  const final = listResults(deps.db, run.id);
  // `done` is a series in which every selected task was judged. A task that errored (no project, checkout failed, dispatch refused) was not: the
  // series is `failed`, so a comparison and the night's `ensureArm` do not take it for a finished measurement (the CHECK of the column has no other word).
  const state: BenchRun["state"] = (failures.length && !final.some((row) => row.state === "accepted" || row.state === "not_accepted")) || final.some((row) => row.state === "error") ? "failed"
    : stopReason && final.some((row) => row.state === "skipped_budget") ? "stopped_budget" : "done";
  finishRunRow(deps.db, run.id, state, failures[0] ?? stopReason, clock.now());
  const saved = getRun(deps.db, set.id, input.arm, repeat)!;
  return {
    version: set.version, arm: input.arm, repeat, state, stopReason: failures[0] ?? stopReason, tasks: tasks.length,
    ran: final.filter((row) => row.state === "accepted" || row.state === "not_accepted").length, accepted: final.filter((row) => row.accepted).length,
    skipped: final.filter((row) => row.state === "skipped_budget").length, spentTokens: saved.spentTokens, seconds: final.reduce((sum, row) => sum + (row.seconds ?? 0), 0),
  };
}

import { hubFields, writeHubFields } from "../platform";
import { WALL_CONFIG_KEY, parseWallConfig, type WallConfig } from "./config";
import type { EvidencePack, HuntOutcome, PackFile } from "./pack";
import type { RerunPlan, RerunScope } from "./rerun";
import { cycleScoresOf } from "./select";
import type { RepairFile } from "./acceptance";
import { listClasses, type WallDb } from "./journal";
import { listRepairs } from "./store";
import type { JevSettings } from "@lane-pilot/jev";
import { createHunt } from "./service/hunt";
import { createBacklog } from "./service/backlog";
import { createTaskWalls } from "./service/task-walls";
import { createReleaseFollow } from "./service/release-follow";
import { createRepairs } from "./service/repairs";
import { createNight } from "./service/night";
import { createReads } from "./service/reads";
import { ROLLBACK_TRIES, askSha, taskWallKey, classWallKey, LOOP_PREFIX, loopWallKey, type WallCtx } from "./service/context";

/** The graph that runs the hunters and the analysis of a wall. */
export const WALL_HUNT_WORKFLOW = "lp.wall-hunt";

export { ROLLBACK_TRIES, askSha, taskWallKey, classWallKey, LOOP_PREFIX, loopWallKey };

export type Scope = { isReal(projectId: string, taskId: string): boolean; scopeOf(projectId: string): RerunScope };
export type ThreadRun = { text: string | null; tokens: number };
export type RepairView = { threadId: string | null; verdict: string | null; outcome: string | null; branch: string | null; worktreePath: string | null; spawnedAt: number | null };

/** Everything the loop needs from outside its database; the plugin wires the real ones (server/wall.ts), tests pass fakes. */
export type WallPorts = {
  now(): number;
  version: string;
  loadScope(): Promise<Scope>;
  logLines(since: number, until: number): Array<{ message: string; at: number; projectId: string }>;
  /** Source files that emit a failure's wording, as the hunters' evidence (empty when the checkout is out of reach). */
  codeFiles(fragments: readonly string[]): Promise<PackFile[]>;
  /** A read-only reader with no tools (a hunter or the full analysis) in another model's seat. Used when `graph` is not set (the tests' fakes). */
  reader?(prompt: string, who: "hunter" | "analysis"): Promise<ThreadRun>;
  /**
   * The model work as a graph run (`lp.wall-hunt`, night-graphs/server/wall-hunt-graph.ts): the hunters side by side, or the analysis, as a run of that
   * graph that records its result in the wall row. When set it replaces `reader`; a run that fails gives null and the hunt reads as «unknown».
   */
  graph?: {
    hunt(input: { wallKey: string; pack: EvidencePack; angles: readonly string[] }): Promise<{ outcome: HuntOutcome; tokens: number } | null>;
    analysis(input: { wallKey: string; prompt: string }): Promise<ThreadRun | null>;
  };
  /** The hidden thread of one reader of the graph, tied to the step that asks (its spawn id and metadata); returns the thread's id. */
  spawnReader?(input: { who: "hunter" | "analysis"; prompt: string; graph: { spawnId: string; metadata: Record<string, unknown> } }): Promise<string>;
  /** Writes a file into the wall's environment folder for the long material a brief names instead of inlining; returns the path the reader opens, or null. */
  writeText?(relPath: string, content: string): Promise<string | null>;
  /** Removes a material file written for a step once the step read it (a stray temp file must not stay in the checkout). */
  deleteText?(absPath: string): Promise<void>;
  /** Whether the reader threads of `who` (their provider) can open a file themselves; a wall-hunter has no file tools otherwise. */
  readerReadsFiles?(who: "hunter" | "analysis"): Promise<boolean>;
  tellPm(threadId: string, text: string): Promise<boolean>;
  repair: {
    view(signature: string): Promise<RepairView | null>;
    report(threadId: string): Promise<string>;
    tokens(threadId: string): Promise<number | null>;
    busy(threadId: string): Promise<boolean>;
    changedFiles(view: RepairView): Promise<RepairFile[] | null>;
    revert(commit: string): Promise<{ ok: boolean; detail: string }>;
  };
  release: {
    drill(): Promise<{ version: string; at: number; ok: boolean } | null>;
    canary(): Promise<{ version: string; tripped: boolean; windowOpen: boolean } | null>;
    /** The repository files changed from one released version to a later one; null when unknown (the release tags are not there). Absent in fakes: then a later release voids. */
    changedBetween?(from: string, to: string): Promise<string[] | null>;
  };
  bench: {
    available(): Promise<boolean>;
    /** The newest set version that has a `done` run of this arm; null when the arm was never measured. */
    armSet(arm: string): Promise<string | null>;
    ensureArm(arm: string, setVersion?: string): Promise<"done" | "running" | "unavailable">;
    compare(base: string, arm: string, setVersion?: string): Promise<"pass" | "fail" | "inconclusive" | "pending" | "unavailable">;
    score(arm: string): Promise<number | null>;
  };
  restart(plan: RerunPlan): Promise<{ ok: boolean; note: string }>;
  deferrals: { open(input: { id: string; what: string; area: string; projectId: string | null }): void; close(id: string, evidence: string): void };
};

type Kv = { get(key: string): Promise<unknown>; set(key: string, value: never): Promise<unknown> };
export type WallDeps = {
  db: WallDb;
  kv: Kv;
  ports: WallPorts;
  log(line: string): void;
  hubDb?: string;
  settings?: () => Promise<JevSettings>;
  diffHiddenAudit?: (limit: number) => Promise<unknown>;
  /** The writer's skill-switch morning line (src/rooms/writer/skill-switch.ts), injected so the wall does not import the writer room. */
  skillSwitchMorningLine: (db: WallDb, now: number) => string | null;
};

export function createWall(deps: WallDeps) {
  const { db, kv, ports, log } = deps;

  /** The settings of the global level (`wall.*`) over what the old key-value store holds: a field with no row reads the old value. */
  async function config(): Promise<WallConfig> {
    const old = await kv.get(WALL_CONFIG_KEY);
    return parseWallConfig({ ...(old && typeof old === "object" ? old : {}), ...hubFields(db, "wall") });
  }
  async function setConfig(patch: Partial<WallConfig>): Promise<WallConfig> {
    const next = parseWallConfig({ ...(await config()), ...patch });
    // Only the fields the caller named become settings rows, with the value the parser settled on (the clamped one).
    writeHubFields(db, "wall", Object.fromEntries(Object.keys(patch).map((field) => [field, (next as Record<string, unknown>)[field]])));
    return next;
  }

  /** The class's cycle history for `shouldStopCycle`: the bench score before the first repair, then after each repair that was judged. */
  const cycleScores = (): number[] => cycleScoresOf(listRepairs(db));

  const ctx: WallCtx = { db, kv, ports, log, deps, config, cycleScores };
  const hunting = createHunt(ctx);
  const { escalateBacklog } = createBacklog(ctx, hunting);
  const tasks = createTaskWalls(ctx, hunting, escalateBacklog);
  const follow = createReleaseFollow(ctx, escalateBacklog);
  const repairs = createRepairs(ctx, tasks, follow);
  const { runNight } = createNight(ctx, hunting, escalateBacklog, tasks);
  const reads = createReads(ctx);

  return { graph: hunting.graphSteps, config, setConfig, runNight,
    advance: repairs.advance, mergeGate: repairs.mergeGate, settled: repairs.settled, started: repairs.started, startFailed: repairs.startFailed, nextAssignment: repairs.nextAssignment,
    noteTaskStop: tasks.noteTaskStop, dispatchGuard: tasks.dispatchGuard, loopExhausted: tasks.loopExhausted, loopTopics: tasks.loopTopics,
    rerun: repairs.rerun, status: reads.status, show: reads.show, close: reads.close,
    morning: reads.morning, classes: () => listClasses(db), huntClass: hunting.huntClass };
}

export type WallApi = ReturnType<typeof createWall>;

import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { noOptionalPlugins } from "../optional-plugin-stubs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrototypeConfig, TaskV2 } from "../../src/rooms/contracts";
import { createAttempt, createRun, createTask, getAttempt, listOpenAttempts, openDatabase, savePrototypeConfig, saveTaskPlan, setAttemptWorkspace, setRunThread, transitionAttempt } from "../../src/rooms/storage/database";
import { createCore } from "../../src/rooms/core/server/core";
import { attemptMergeMessage, clearMergeIntent, recordMergeIntent, type RunOnHost } from "../../src/rooms/verification/server/merge-intent";
import type { Services } from "../../src/rooms/core/server/services";
import { createStability } from "../../src/rooms/stability/server/stability";
import { recordStage } from "../../src/rooms/runs/server/stage-records";
import { createTaskReconcile } from "../../src/rooms/runs/server/task-reconcile";
import { createWriterStart } from "../../src/rooms/writer/server/start";
import regressionSeeds from "./regression-seeds.json";

/**
 * Deterministic fault-injection simulation. A seeded random schedule drives the real writer loop (start.ts), stability layer,
 * ordered task reconcile and merge-intent recovery against a model of the machine: a git history that records every merge,
 * a writer that fails in the usual ways, and faults at the worst points of a merge (before it, after it with the reply
 * lost, after the reply but before the attempt's state is written) together with plugin reloads, which drop every loop
 * and close the database for it. Spawn and finish are stubs that follow the same order of steps as the real ones
 * (writer/spawn.ts, writer/finish.ts: intent record, merge, transition, clear).
 *
 * After the random phase the faults stop and the recovery gets time to settle. Then:
 *  1. no task is stuck: every task's latest attempt is accepted, blocked (with a reason) or canceled;
 *  2. no double accept: at most one accepted attempt per task;
 *  3. no double merge: a task's work lands in main at most once;
 *  4. no lost merge: work that landed in main means an accepted attempt.
 *
 * A failing seed is printed with the violated invariant. Add it to regression-seeds.json: it then runs on every suite.
 */

const WORKSPACE = "/ws";
const SEEDS = Array.from({ length: Number(process.env.LP_SIM_SEEDS ?? 30) }, (_, index) => index + 1);

const config: PrototypeConfig = { projectId:"proj1", hostId:"h1", pmWorkspacePath:WORKSPACE, writerWorkspacePath:WORKSPACE,
  pmProviderId:"p", pmModel:"pm", writerProviderId:"p", writerModel:"wm" };

const contract = (id:string):TaskV2 => ({
  schema_version:2, id, title:`Task ${id}`, risk:"low", lane:"writer", project_cwd:WORKSPACE, read_first:[], interfaces:[], invariants:[],
  out_of_scope:[], expected_outputs:[`${id}/a.txt`], owns_paths:[`${id}/**`], never_touch:[], depends_on:[],
  objective:`Make ${id}`, acceptance:["done"], verify:"tests", verification:[{ command:"npm test", cwd:WORKSPACE }],
});

/** mulberry32: a small seeded generator, so a seed always replays the same schedule. */
function random(seed:number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Commit = { sha:string; attemptCommit:string; taskId:string; message:string };

/** The machine: main's history and the attempts' worktrees, answering the few git questions Lane Pilot asks. */
function createModel(rand:() => number) {
  const log:Commit[] = [];
  const worktrees = new Map<string, { dirty:boolean }>(); // attemptId -> still there
  const merges = new Map<string, number>(); // taskId -> times its work landed
  const mergedAttempts = new Set<string>();
  let hostOffline = false;
  const head = () => log.at(-1)?.sha ?? "M0";
  /** What main's history holds up to a commit (its head by default): the commits, and the attempts' own commits they merged. */
  const ancestors = (upTo?:string) => {
    const end = upTo === undefined || upTo === "HEAD" ? log.length : upTo === "M0" ? 0 : log.findIndex((commit) => commit.sha === upTo) + 1;
    return new Set(["M0", ...log.slice(0, end).flatMap((commit) => [commit.sha, commit.attemptCommit])]);
  };
  const answer = (cwd:string, command:string) => {
    if (hostOffline) throw new Error("host is not connected");
    const ok = (stdout:string) => ({ exitCode:0, stdout, stderr:"" });
    const no = (exitCode = 1) => ({ exitCode, stdout:"", stderr:"" });
    if (command.startsWith("git rev-parse HEAD; git -C")) {
      const wt = /git -C '([^']+)' rev-parse HEAD/.exec(command)![1]!;
      const attemptId = wt.split("/").pop()!;
      const tree = worktrees.get(attemptId);
      // A writer's loose edits are not committed yet: the worktree's head is main's own.
      return ok(`${head()}\n${tree?.dirty ? head() : `c:${attemptId}`}\nlane/${attemptId}\n`);
    }
    if (command === "git rev-parse HEAD") return ok(`${head()}\n`);
    const ancestor = /^git merge-base --is-ancestor '([^']+)' (?:HEAD|'([^']+)')$/.exec(command);
    if (ancestor) return ancestors(ancestor[2]).has(ancestor[1]!) ? ok("") : no();
    if (command.startsWith("git status --porcelain")) {
      const attemptId = cwd.split("/").pop()!;
      const tree = worktrees.get(attemptId);
      if (!tree) return no(128);
      return ok(`${tree.dirty ? " M file.ts\n" : ""}c:${attemptId}\n`);
    }
    const grep = /--grep='Lane-Pilot-Attempt: (.*)' (?:'([^']+)\.\.HEAD'|--since=@\d+ HEAD)$/.exec(command.replace(/'\\''/g, "'"));
    if (grep) {
      const from = !grep[2] || grep[2] === "M0" ? -1 : log.findIndex((commit) => commit.sha === grep[2]);
      const found = log.slice(from + 1).find((commit) => commit.attemptCommit === `c:${grep[1]}`);
      return found ? ok(`${found.sha}\x1f${found.message}\n\x1e`) : ok("");
    }
    return no(127);
  };
  return {
    log, merges, worktrees, head, mergedAttempts, answer,
    setOffline: (value:boolean) => { hostOffline = value; },
    /** gitIntegrate: lands the attempt's work in main once; a second attempt of the same task lands it again (a double merge). */
    integrate(attemptId:string, taskId:string, message:string, removeWorktree:boolean):"merged" | "up-to-date" {
      if (hostOffline) throw new Error("host is not connected"); // nothing merges while the machine is unreachable
      if (mergedAttempts.has(attemptId)) return "up-to-date";
      mergedAttempts.add(attemptId);
      merges.set(taskId, (merges.get(taskId) ?? 0) + 1);
      log.push({ sha:`m:${log.length + 1}`, attemptCommit:`c:${attemptId}`, taskId, message:`Merge writer work: ${message}` });
      const tree = worktrees.get(attemptId);
      if (tree) tree.dirty = false;
      if (removeWorktree && rand() < 0.5) worktrees.delete(attemptId);
      return "merged";
    },
  };
}

type Instance = { ctx:ReturnType<typeof createCore>; services:Services; dead:boolean; reconcile:ReturnType<typeof createTaskReconcile> };

async function simulate(seed:number):Promise<{ violations:string[]; summary:string }> {
  const rand = random(seed);
  const model = createModel(rand);
  const { bb, harness } = createFakePluginHost({ pluginId:"lane-pilot" });
  harness.sdk.stub("threads.get", async (args:{ threadId:string }) => ({ id:args.threadId, status:"idle" }));
  harness.sdk.stub("threads.send", async () => undefined);
  harness.sdk.stub("threads.context", async () => ({ usage:null }));
  harness.sdk.stub("threads.updatePluginMetadata", async () => ({}));
  harness.sdk.stub("threads.events.list", async () => []);
  harness.sdk.stub("threads.getPluginMetadata", async () => ({ role:"pm", lanePilotRunId:"run1" }));
  const rawDb = openDatabase(bb);
  createRun(rawDb, "run1", "proj1", "bb", WORKSPACE);
  setRunThread(rawDb, "run1", "thr_pm");
  savePrototypeConfig(rawDb, config);
  let faults = true;
  const chance = (p:number) => faults && rand() < p;
  const taskIds = Array.from({ length:3 + Math.floor(rand() * 4) }, (_, index) => `T${index + 1}`);
  const hostRun:RunOnHost = async (_hostId, cwd, command) => model.answer(cwd, command);

  let instance!:Instance;
  const makeInstance = ():Instance => {
    const self = { dead:false } as Instance;
    // A reload closes the database for everything the old instance still runs.
    const db = new Proxy(rawDb, { get(target, key) {
      if (self.dead && (key === "prepare" || key === "transaction" || key === "exec")) throw new Error("database is closed");
      const value = (target as never)[key] as unknown;
      return typeof value === "function" ? (value as (...args:unknown[]) => unknown).bind(target) : value;
    } });
    const ctx = createCore(bb, db);
    const services = {
      activeWriterTasks:new Set<string>(),
      providerBreaker:{ record:() => undefined },
      ...noOptionalPlugins,
      runBudgetFor:() => ({ check:() => ({ ok:true }), noteAttempt:() => undefined, noteTokens:() => undefined, snapshot:() => ({ limits:{} }) }),
      runWriterPool:{ acquire:async () => () => undefined },
      maintainMemoryAfterAcceptance:() => undefined,
      maintainProjectLifeAfterAcceptance:() => undefined,
      workspaceDirt:async () => ({ ok:true, paths:[], snapshots:[] }),
      isLiveFolder:async () => false,
      restoreLiveFolder:async () => ({ ok:true, restored:[], removed:[], failed:[] }),
      enqueueResumedWriter:async (_projectId:string, attempt:{ id:string; task_id:string; thread_id:string | null }) => {
        resume(self, attempt);
        return true;
      },
      reconcileAttemptThread:async () => "",
      resumeOrphans:async () => {
        // The recovery of attempts in flight: one with a thread goes on to its finish; one whose spawn never answered is rejected
        // (reconcile found no thread), and the ordinary recovery takes it from there.
        for (const row of listOpenAttempts(db)) {
          if (self.services.activeWriterTasks.has(`${row.run_id}:${row.task_id}`)) continue;
          const attempt = getAttempt(db, row.id)!;
          if ((attempt.state === "spawn_requested" || attempt.state === "spawn_unknown") && !attempt.thread_id) {
            transitionAttempt(db, attempt.id, "spawn_rejected", { reason:"reconcile completed on a short page without a matching thread" });
            continue;
          }
          resume(self, attempt);
        }
      },
      spawnWriterAttempt:async (input:{ attemptId:string }) => {
        if (self.dead) throw new Error("database is closed");
        const roll = rand();
        if (faults && roll < 0.1) {
          transitionAttempt(db, input.attemptId, "spawn_requested");
          transitionAttempt(db, input.attemptId, "spawn_rejected", { reason:"spawn failed: HTTP 502" });
          return { ok:false, status:"spawn_rejected", reason:"spawn failed: HTTP 502", attemptId:input.attemptId };
        }
        setAttemptWorkspace(db, input.attemptId, { path:WORKSPACE, environmentId:null, decision:{ strategy:"inherit_run", reason:"explicit_worktree" } });
        transitionAttempt(db, input.attemptId, "spawn_requested");
        transitionAttempt(db, input.attemptId, "running", { threadId:`thr_${input.attemptId}` });
        model.worktrees.set(input.attemptId, { dirty:rand() < 0.5 });
        return { ok:true, threadId:`thr_${input.attemptId}`, providerId:"p", model:"wm", dirtBefore:[], workspacePath:WORKSPACE };
      },
      finishWriterAttempt:async (input:{ attemptId:string; taskId:string; runId:string; writerThreadId:string }) => {
        const alive = () => { if (self.dead) throw new Error("database is closed"); };
        alive();
        const base = { attemptId:input.attemptId, writerThreadId:input.writerThreadId };
        const roll = rand();
        if (faults && roll < 0.12) {
          transitionAttempt(db, input.attemptId, "provider_error", { reason:"writer thread status error" });
          return { status:"provider_error", reason:"writer thread status error", ...base };
        }
        if (faults && roll < 0.2) {
          transitionAttempt(db, input.attemptId, "validation_failed", { reason:"verification failed (npm test): exit 1" });
          return { status:"validation_failed", reason:"verification failed (npm test): exit 1", ...base };
        }
        if (faults && roll < 0.24) {
          transitionAttempt(db, input.attemptId, "blocked", { reason:"needs_human: which colour?" });
          return { status:"blocked", reason:"needs_human: which colour?", ...base };
        }
        const message = attemptMergeMessage({ id:input.taskId, title:`Task ${input.taskId}` }, input.attemptId);
        const kv = bb.storage.kv as never;
        await recordMergeIntent(kv, hostRun, { attemptId:input.attemptId, runId:input.runId, taskId:input.taskId, projectId:"proj1", hostId:"h1",
          basePath:WORKSPACE, worktreePath:`/wt/${input.attemptId}`, message });
        const die = () => { self.dead = true; throw new Error("database is closed"); };
        if (chance(0.05)) die(); // reloaded before the merge started
        if (chance(0.05)) throw new Error("gitIntegrate: host call timed out"); // answered nothing, merged nothing
        model.integrate(input.attemptId, input.taskId, message, true);
        if (chance(0.08)) throw new Error("gitIntegrate: host reply lost"); // merged, the reply never arrived
        if (chance(0.05)) die(); // merged and answered, reloaded before the state was written
        transitionAttempt(db, input.attemptId, "accepted");
        await clearMergeIntent(bb.storage.kv as never, input.attemptId);
        return { status:"accepted", produced:["a.txt"], verification:[], ...base };
      },
    } as unknown as Services;
    self.services = services;
    self.ctx = ctx;
    Object.assign(services, createStability(ctx, services));
    // Task reconcile asks the machine through the host: here, the model.
    const hostCtx = { ...ctx, host:{ call:async (_method:string, input:{ cwd:string; command:string }) => model.answer(input.cwd, input.command) } } as never;
    self.reconcile = createTaskReconcile(hostCtx, services);
    Object.assign(services, createWriterStart(ctx, services));
    return self;
  };

  const resume = (self:Instance, attempt:{ id:string; task_id:string; thread_id:string | null }) => {
    const task = contract(attempt.task_id);
    self.services.startWriterTask({ projectId:"proj1", runId:"run1", taskId:attempt.task_id, firstAttemptId:attempt.id, pmThreadId:"thr_pm", config,
      task, plan:`Plan for ${attempt.task_id}`, ...(attempt.thread_id ? { writerThreadId:attempt.thread_id } : {}) });
  };

  const reload = async () => {
    instance.dead = true;
    instance.ctx.state.disposed = true;
    instance = makeInstance();
    await instance.reconcile.reconcileTasks({ phase:"startup", step:async (_name, work) => { try { await work(); } catch { /* a step that throws skips */ } } });
  };
  const periodic = () => instance.reconcile.reconcileTasks({ phase:"periodic", step:async (_name, work) => { if (instance.dead) return; try { await work(); } catch { /* skipped */ } } });
  const settle = (ms:number) => vi.advanceTimersByTimeAsync(ms);

  vi.useFakeTimers({ toFake:["setTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-10-07T10:00:00Z"));
  instance = makeInstance();
  // Dispatch: every task gets its attempt and stages, and its loop starts.
  for (const taskId of taskIds) {
    createTask(rawDb, { id:taskId, runId:"run1", kind:"bb", contract:contract(taskId) });
    saveTaskPlan(rawDb, taskId, `Plan for ${taskId}`);
    for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) recordStage(rawDb, { runId:"run1", taskId, stageId, state:"pending", input:`Plan for ${taskId}` });
    const attemptId = `${taskId}-a1`;
    createAttempt(rawDb, { id:attemptId, runId:"run1", taskId });
    resume(instance, { id:attemptId, task_id:taskId, thread_id:null });
  }
  const rounds = 12 + Math.floor(rand() * 12);
  for (let round = 0; round < rounds; round += 1) {
    await settle(Math.floor(rand() * 90_000));
    model.setOffline(chance(0.1));
    if (instance.dead || chance(0.2)) await reload();
    if (chance(0.5)) await periodic();
  }
  // The faults stop; the recovery gets hours to settle (a pass every five minutes, reloads over).
  faults = false;
  model.setOffline(false);
  await reload();
  for (let pass = 0; pass < 60; pass += 1) {
    await settle(5 * 60_000);
    await periodic();
  }
  await settle(3 * 3600_000);

  const violations:string[] = [];
  const rows = rawDb.prepare("SELECT id, task_id, state, reason, created_at, attempt_no FROM lane_pilot_attempt ORDER BY created_at, attempt_no").all() as
    Array<{ id:string; task_id:string; state:string; reason:string | null }>;
  for (const taskId of taskIds) {
    const attempts = rows.filter((row) => row.task_id === taskId);
    const latest = attempts.at(-1);
    const accepted = attempts.filter((row) => row.state === "accepted");
    if (!latest || !["accepted", "blocked", "canceled"].includes(latest.state) && !accepted.length) violations.push(`${taskId}: stuck in ${latest?.state ?? "no attempt"} (${latest?.reason ?? ""})`);
    if (latest?.state === "blocked" && !accepted.length && !(latest.reason ?? "").trim()) violations.push(`${taskId}: blocked with no reason`);
    if (accepted.length > 1) violations.push(`${taskId}: ${accepted.length} attempts accepted (${accepted.map((row) => row.id).join(", ")})`);
    if ((model.merges.get(taskId) ?? 0) > 1) violations.push(`${taskId}: its work landed in main ${model.merges.get(taskId)} times`);
    if ((model.merges.get(taskId) ?? 0) >= 1 && !accepted.length) violations.push(`${taskId}: its work is in main but no attempt is accepted (latest ${latest?.state}: ${latest?.reason})`);
  }
  const summary = `seed ${seed}: ${taskIds.map((taskId) => `${taskId}=${rows.filter((row) => row.task_id === taskId).at(-1)?.state}`).join(" ")} merges=${model.log.length}`;
  if (process.env.LP_SIM_DEBUG && violations.length) console.log(`${rawDb.prepare("SELECT id, task_id, state, created_at FROM lane_pilot_attempt ORDER BY created_at").all().map((row) => JSON.stringify(row)).join("\n")}\n${model.log.map((commit) => JSON.stringify(commit)).join("\n")}\n${rawDb.prepare("SELECT attempt_id, from_state, to_state, refused, reason FROM lane_pilot_attempt_transition ORDER BY rowid").all().map((row) => JSON.stringify(row)).join("\n")}\n${JSON.stringify(await bb.storage.kv.get("stability:parked"))}\n${summary}\n${harness.logEntries.filter((entry) => entry.level !== "info").map((entry) => `${entry.level}: ${entry.message}`).join("\n")}`);
  await harness.lifecycle.dispose();
  return { violations, summary };
}

afterEach(() => { vi.useRealTimers(); });

describe("seeded fault-injection simulation", () => {
  const seeds = [...new Set([...(regressionSeeds as { seeds:Array<{ seed:number }> }).seeds.map((row) => row.seed), ...SEEDS])];
  it("keeps the failing seeds it found as regressions", () => expect(regressionSeeds.seeds.length).toBeGreaterThan(0));
  it.each(seeds)("seed %i keeps every invariant", async (seed) => {
    const { violations, summary } = await simulate(seed);
    expect(violations, `${summary}\nA failing seed is a regression: add it to tests/simulation/regression-seeds.json`).toEqual([]);
  }, 60_000);

  it("replays the same schedule for the same seed", async () => {
    const first = await simulate(7);
    const second = await simulate(7);
    expect(second.summary).toBe(first.summary);
  }, 60_000);
});

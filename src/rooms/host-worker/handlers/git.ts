import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExperimentalHostRpcHandlers } from "@get-bb/plugin-sdk";
import { hostContract } from "../../contracts";
import { ENVIRONMENT_REASON } from "../../contracts/failure-class";
import { readCheckRun } from "../../tasks/server";
import { sweepLaneWorktrees } from "../../verification";
import { createWorktree, integrateWorktree, mergeInfo, prepareWorktree, removeLaneWorktree, revertCommitsInWorktree, syncWorktree, snapshotWorktree, worktreeState, type ReplayCheck, type ReplayCheckOutcome } from "../../verification";
import { attributeGateOnHost, bisectGateOnHost, runGateOnHost } from "../../verification";
import { cachedReplayVerdicts, recordReplayVerdict, replayKey } from "../../verification";
import { glueReplayCommands } from "../../verification/server";
import { gitOwnershipChangedPaths, resolveGitOwnershipBase, undoCheckWrites, revertPaths } from "../../verification";
import { runSandboxedCommandOnHost } from "../../verification";

export const gitOwnershipBase: ExperimentalHostRpcHandlers<typeof hostContract>["gitOwnershipBase"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  ...await resolveGitOwnershipBase({projectCwd:input.projectCwd,baseRef:input.baseRef}),
});

export const gitPrepareWorktree: ExperimentalHostRpcHandlers<typeof hostContract>["gitPrepareWorktree"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  ...await prepareWorktree({basePath:input.basePath,worktreePath:input.worktreePath,
    ...(input.ownsBarrier?{ownsBarrier:true,ownsPaths:input.ownsPaths??[],neverTouch:input.neverTouch??[]}:{})}),
});

export const gitIntegrate: ExperimentalHostRpcHandlers<typeof hostContract>["gitIntegrate"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  ...await integrateWorktree({basePath:input.basePath,worktreePath:input.worktreePath,message:input.message,removeWorktree:input.removeWorktree,committedOnly:input.committedOnly,bookkeeping:input.bookkeeping,
    ownsPaths:input.ownsPaths,baseInHead:input.baseInHead,expectedHead:input.expectedHead,
    replayCheck:input.replayChecks?()=>runReplayChecks(input.requestedHostId,input.replayChecks!):undefined}),
});

/** The host has no sandbox backend (or refuses to launch one): every replay check would fail the same way. */
const NO_SANDBOX=/sandbox_backend_unavailable|no sandbox backend|Seatbelt launch was denied|bubblewrap (?:is )?(?:not found|unavailable)/i;

/**
 * The task's checks in the sandbox, in the attempt's worktree, while the integration holds the base checkout. The first red
 * one (twice red: a flaky one passes the second time) ends it. A check that could not run (no sandbox backend, a folder gone, the
 * machine broke it) proves nothing either way: it is not a pass. It is reported as «not run» (`environment`), which holds the
 * merge, and the writer is not charged for it; a real red found by another check still wins over it.
 */
async function runReplayChecks(requestedHostId:string,checks:NonNullable<Parameters<ExperimentalHostRpcHandlers<typeof hostContract>["gitIntegrate"]>[0]["replayChecks"]>):Promise<ReplayCheckOutcome> {
  // The same reading of a result as the writer's own check (verify.ts, readCheckRun): a timeout is not run again, an empty re-run is
  // not a pass, a zero-test green is red, and the first real red stands whatever the re-run says (a re-run that died of the machine
  // does not erase it, as the writer's runWithFlakyRerun keeps the first result too). The machine's own failure skips only that check.
  type Ran={exitCode:number;stdout:string;stderr:string;threw?:true};
  // A check's verdict belongs to the revision it ran on: a retried integration (the hub restarted mid-merge, a queue retry) finds
  // the same rebased head and reuses the recorded result instead of running the suite again (graphs-optimisation G8: 50 h of
  // repeat checks). Only a settled result is kept — an environment failure has to run again.
  // A chain of one runner (A && B) is glued into a single run; exact repeats of a command run once (graphs G2/G8).
  const commands=glueReplayCommands(checks.commands);
  const cached=await cachedReplayVerdicts(checks.workspacePath,commands);
  const notRun:ReplayCheck[]=[];
  for(const check of commands) {
    const seen=cached?.entries[replayKey(check.command,check.cwd)];
    // Already settled on this revision: a recorded pass skips the run, a recorded red fails the merge again with its output.
    if(seen&&seen.exitCode===0) continue;
    if(seen) return {ok:false,failed:[{command:check.command,exitCode:seen.exitCode||1,stdout:seen.stdout,stderr:`already run on this revision\n${seen.stderr}`}]};
    const attempt=():Promise<Ran>=>runSandboxedCommandOnHost({requestedHostId,workspacePath:checks.workspacePath,cwd:check.cwd,backend:checks.backend,command:check.command,timeoutSec:check.timeoutSec})
      .catch((cause:unknown)=>({exitCode:1,stdout:"",stderr:cause instanceof Error?cause.message:String(cause),threw:true as const}));
    const row=(result:Ran,why?:string):ReplayCheck=>({command:check.command,exitCode:result.exitCode||1,stdout:result.stdout,stderr:why?`${why}\n${result.stderr}`:result.stderr});
    const red=(result:Ran,why?:string):ReplayCheckOutcome=>({ok:false,failed:[row(result,why)]});
    const passed=async(result:Ran)=>recordReplayVerdict(checks.workspacePath,check.command,check.cwd,{exitCode:0,stdout:result.stdout,stderr:result.stderr});
    const failed=async(result:Ran,why?:string)=>recordReplayVerdict(checks.workspacePath,check.command,check.cwd,{exitCode:result.exitCode||1,stdout:result.stdout,stderr:why?`${why}\n${result.stderr}`:result.stderr});
    const first=await attempt();
    // No sandbox on this host at all: no check of any task can ever run here, so holding merges would stop every task of the project.
    // The merge goes on as before 0.1.337 and the post-merge check on main runs it; only a check that could run and did not is held.
    if(first.threw&&NO_SANDBOX.test(first.stderr)) { console.warn(`lane-pilot: no sandbox for the replay check, the merge goes on and main's check runs it: ${check.command}`); continue; }
    const readFirst=readCheckRun(first,{command:check.command});
    if(readFirst.verdict==="pass") { await passed(first); continue; }
    if(readFirst.verdict==="not_run") return red(first,`check failed: ${readFirst.reason}`);
    if(first.exitCode===124) { if(readFirst.verdict==="product_fail") { await failed(first); return red(first); } notRun.push(row(first)); continue; }
    const again=await attempt();
    const readAgain=readCheckRun(again,{command:check.command,first});
    if(readAgain.verdict==="pass") { await passed(again); continue; }
    if(readFirst.verdict==="product_fail") {
      const why=readAgain.verdict==="product_fail"?undefined:`the re-run did not settle it (${readAgain.verdict==="environment_error"?"the check could not run again":readAgain.reason}); the first failure stands`;
      await failed(first,why);
      return red(first,why);
    }
    // The first run was the machine's: a real red on the re-run is the code's, anything else is not run.
    if(readAgain.verdict==="product_fail") { await failed(again); return red(again); }
    notRun.push(row(again));
  }
  if(notRun.length) {
    console.warn(`lane-pilot: replay check could not run, the merge waits for the environment: ${notRun.map((check)=>check.command).join(", ")}`);
    return {ok:false,environment:true,failed:notRun.map((check)=>({...check,stderr:`${ENVIRONMENT_REASON}the check did not run, so it proves nothing; no writer can fix that\n${check.stderr}`}))};
  }
  return {ok:true};
}

export const gateRun: ExperimentalHostRpcHandlers<typeof hostContract>["gateRun"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  ...await runGateOnHost({basePath:input.basePath,command:input.command,timeoutSec:input.timeoutSec}),
});

export const gateBisect: ExperimentalHostRpcHandlers<typeof hostContract>["gateBisect"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  ...await bisectGateOnHost({basePath:input.basePath,command:input.command,goodSha:input.goodSha,badSha:input.badSha,timeoutSec:input.timeoutSec}),
});

export const gateAttribute: ExperimentalHostRpcHandlers<typeof hostContract>["gateAttribute"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  ...await attributeGateOnHost({basePath:input.basePath,baseSha:input.baseSha,commits:input.commits,failing:input.failing,timeoutSec:input.timeoutSec}),
});

export const gitWorktreeSnapshot: ExperimentalHostRpcHandlers<typeof hostContract>["gitWorktreeSnapshot"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  ...await snapshotWorktree({worktreePath:input.worktreePath,name:input.name,dir:join(homedir(),".lane-pilot","released")}),
});

export const gitRemoveWorktree: ExperimentalHostRpcHandlers<typeof hostContract>["gitRemoveWorktree"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  // With `release` the work is returned (saved as a patch) before the worktree goes; a snapshot that fails keeps it (SMA rule 9).
  ...await removeLaneWorktree({basePath:input.basePath,worktreePath:input.worktreePath,...(input.release?{releaseDir:join(homedir(),".lane-pilot","released")}:{})}),
});

export const gitWorktreeState: ExperimentalHostRpcHandlers<typeof hostContract>["gitWorktreeState"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  ...await worktreeState({basePath:input.basePath,worktreePath:input.worktreePath}),
});

export const gitMergeInfo: ExperimentalHostRpcHandlers<typeof hostContract>["gitMergeInfo"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  ...await mergeInfo({basePath:input.basePath,...(input.commit?{commit:input.commit}:{}),...(input.attemptId?{attemptId:input.attemptId}:{})}),
});

export const gitRevertCommits: ExperimentalHostRpcHandlers<typeof hostContract>["gitRevertCommits"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  ...await revertCommitsInWorktree({worktreePath:input.worktreePath,commits:input.commits}),
});

export const gitSyncWorktree: ExperimentalHostRpcHandlers<typeof hostContract>["gitSyncWorktree"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  ...await syncWorktree({basePath:input.basePath,worktreePath:input.worktreePath,keepConflicts:input.keepConflicts}),
});

/**
 * Writer worktrees live in ~/.lane-pilot/worktrees on the host. BB refuses to start a thread in a folder inside its
 * own storage that is not one of its environments (HTTP 409 «Workspace path is inside bb-managed storage»), which
 * is where the plugin's data dir is: every SelfyStudio writer on OVH failed to spawn that way on 2026-10-02.
 */
export const laneWorktreeRoot = () => join(homedir(), ".lane-pilot", "worktrees");

export const gitCreateWorktree: ExperimentalHostRpcHandlers<typeof hostContract>["gitCreateWorktree"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  ...await createWorktree({basePath:input.basePath,name:input.name,...(input.commit?{commit:input.commit}:{}),
    ...(input.taskId?{taskId:input.taskId}:{}),
    targetPath:join(laneWorktreeRoot(),input.name,basename(input.basePath))}),
});

export const worktreeJanitor: ExperimentalHostRpcHandlers<typeof hostContract>["worktreeJanitor"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  ...await sweepLaneWorktrees({root:laneWorktreeRoot(),protectedPaths:new Set(input.protectedPaths),graceMs:input.graceMs??2*3_600_000}),
});

export const gitRevertPaths: ExperimentalHostRpcHandlers<typeof hostContract>["gitRevertPaths"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId, ...await revertPaths({projectCwd:input.projectCwd,paths:input.paths}),
});

export const gitUndoCheckWrites: ExperimentalHostRpcHandlers<typeof hostContract>["gitUndoCheckWrites"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  ...await undoCheckWrites({projectCwd:input.projectCwd,keep:input.keep,ownsPaths:input.ownsPaths,neverTouch:input.neverTouch,bookkeeping:input.bookkeeping}),
});

export const gitOwnershipChanges: ExperimentalHostRpcHandlers<typeof hostContract>["gitOwnershipChanges"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  ...await gitOwnershipChangedPaths({projectCwd:input.projectCwd,baseSha:input.baseSha,compareCommitted:input.compareCommitted,unfiltered:input.unfiltered,bookkeeping:input.bookkeeping}),
});

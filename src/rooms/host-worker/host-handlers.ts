import { networkInterfaces } from "node:os";
import { createWorktree, integrateWorktree, mergeInfo, prepareWorktree, removeLaneWorktree, revertCommitsInWorktree, syncWorktree, snapshotWorktree, worktreeState, type ReplayCheck, type ReplayCheckOutcome } from "../verification";
import { attributeGateOnHost, bisectGateOnHost, runGateOnHost } from "../verification";
import { buildDocsAnchors, docsDepth as readDocsDepth, docsStaleness, jevCallFor, verifyDocsCitations } from "../verification";
import { buildDocsFlows } from "../verification";
import { readMachineFacts, runStabilityDrill, userToolBins } from "../verification";
import { commitDocs, docsLineCounts as readDocsLineCounts, docsWorthinessFacts as readDocsWorthinessFacts, gitDocsScope as readGitDocsScope, revertPaths } from "../verification";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { access, chmod, lstat, mkdir, open, stat, statfs, readFile, readlink, readdir, realpath, rename, unlink } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";
import { homedir } from "node:os";
import type { ExperimentalHostRpcHandlers } from "@get-bb/plugin-sdk";
import { hostContract } from "../contracts";
import { ENVIRONMENT_REASON } from "../runs";
import { readCheckRun } from "../tasks/server";
import { readBoundedWorkspaceFile, sha256Hex } from "@lane-pilot/kit";
import { JEV_PROVIDERS } from "@lane-pilot/jev/provider";
import { casWriteWorkflowFile } from "../storage";
import { inventoryCoexistence, runCoexistenceOperation } from "../native-install";
import { runBrowserQaOnHost } from "../qa";
import { cancelHostJob, hostJobStatus, startHostJob } from "./jobs";
import { scanCritiqueCoverage } from "../critique";
import { prepareSandboxedCommandLine, releaseSandboxedCommandLine, runSandboxedCommandOnHost } from "../verification";
import { gitOwnershipChangedPaths, resolveGitOwnershipBase, undoCheckWrites } from "../verification";
import { runCommandOnHost, writePmSettingsOnHost } from "../writer";
import { runScriptOnHost } from "./script-run";
import { probeOpenCodeLimit } from "./opencode-limit";
import { execFile } from "node:child_process";
import { discoverClaudeAgents, prepareNativeClaude } from "../native-agent";
import { prepareBbShim } from "../native-agent";
import {
  connectOpencodeStack,
  detectStack,
  importConfigStack,
  installStack,
  rollbackStack,
  snapshotStack,
  type HostContext,
} from "../native-install";

async function hashFile(path: string): Promise<string> {
  return sha256Hex(await readFile(path));
}

function ctx(input: {
  requestedHostId: string;
  workspacePath?: string;
  threadStoragePath?: string;
  receiptDir?: string;
  confirmExternalOps?: boolean;
  localFallbackPath?: string;
  guardSourcePath?: string;
  pmWorkspacePath?: string;
  projectId?: string;
  snapshotPath?: string;
}): HostContext {
  return { ...input, moduleUrl: import.meta.url };
}

export const coexistenceInventory: ExperimentalHostRpcHandlers<typeof hostContract>["coexistenceInventory"] = async (input) => (
  inventoryCoexistence({ projectId: input.projectId, hostId: input.requestedHostId, targetSha: input.targetSha })
);

export const gitOwnershipBase: ExperimentalHostRpcHandlers<typeof hostContract>["gitOwnershipBase"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  ...await resolveGitOwnershipBase({projectCwd:input.projectCwd,baseRef:input.baseRef}),
});

export const gitPrepareWorktree: ExperimentalHostRpcHandlers<typeof hostContract>["gitPrepareWorktree"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  ...await prepareWorktree({basePath:input.basePath,worktreePath:input.worktreePath}),
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
  const notRun:ReplayCheck[]=[];
  for(const check of checks.commands) {
    const attempt=():Promise<Ran>=>runSandboxedCommandOnHost({requestedHostId,workspacePath:checks.workspacePath,cwd:check.cwd,backend:checks.backend,command:check.command,timeoutSec:check.timeoutSec})
      .catch((cause:unknown)=>({exitCode:1,stdout:"",stderr:cause instanceof Error?cause.message:String(cause),threw:true as const}));
    const row=(result:Ran,why?:string):ReplayCheck=>({command:check.command,exitCode:result.exitCode||1,stdout:result.stdout,stderr:why?`${why}\n${result.stderr}`:result.stderr});
    const red=(result:Ran,why?:string):ReplayCheckOutcome=>({ok:false,failed:[row(result,why)]});
    const first=await attempt();
    // No sandbox on this host at all: no check of any task can ever run here, so holding merges would stop every task of the project.
    // The merge goes on as before 0.1.337 and the post-merge check on main runs it; only a check that could run and did not is held.
    if(first.threw&&NO_SANDBOX.test(first.stderr)) { console.warn(`lane-pilot: no sandbox for the replay check, the merge goes on and main's check runs it: ${check.command}`); continue; }
    const readFirst=readCheckRun(first,{command:check.command});
    if(readFirst.verdict==="pass") continue;
    if(readFirst.verdict==="not_run") return red(first,`check failed: ${readFirst.reason}`);
    if(first.exitCode===124) { if(readFirst.verdict==="product_fail") return red(first); notRun.push(row(first)); continue; }
    const again=await attempt();
    const readAgain=readCheckRun(again,{command:check.command,first});
    if(readAgain.verdict==="pass") continue;
    if(readFirst.verdict==="product_fail") {
      const why=readAgain.verdict==="product_fail"?undefined:`the re-run did not settle it (${readAgain.verdict==="environment_error"?"the check could not run again":readAgain.reason}); the first failure stands`;
      return red(first,why);
    }
    // The first run was the machine's: a real red on the re-run is the code's, anything else is not run.
    if(readAgain.verdict==="product_fail") return red(again);
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

/** Background jobs (B4): ordinary short calls; the long work runs in a process of its own, see src/jobs.ts. */
export const jobStart: ExperimentalHostRpcHandlers<typeof hostContract>["jobStart"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  jobId:await startHostJob({kind:input.kind,input:input.input,timeoutSec:input.timeoutSec,...(input.key?{key:input.key}:{})}),
});

export const jobStatus: ExperimentalHostRpcHandlers<typeof hostContract>["jobStatus"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  jobId:input.jobId,
  ...await hostJobStatus(input.jobId),
});

export const jobCancel: ExperimentalHostRpcHandlers<typeof hostContract>["jobCancel"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  jobId:input.jobId,
  cancelled:await cancelHostJob(input.jobId),
});

export const stabilityDrill: ExperimentalHostRpcHandlers<typeof hostContract>["stabilityDrill"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  checks:await runStabilityDrill(),
});

/** The writer host asks its OpenCode v2 service about a silent writer's session (writer-silence.ts asks only for opencode2 writers). */
export const openCodeLimitProbe: ExperimentalHostRpcHandlers<typeof hostContract>["openCodeLimitProbe"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  ...await probeOpenCodeLimit({sessionId:input.sessionId,sinceMs:input.sinceMs}),
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

/** Free space for whoever decides before a spawn: a full disk (OVH, 2026-10-03) killed the BB host daemon. With `machine`: the host's load and memory too, the reading taken before a check. */
export const diskFree: ExperimentalHostRpcHandlers<typeof hostContract>["diskFree"] = async (input) => {
  const fs = await statfs(input.path);
  return { hostId:process.env.BB_HOST_ID??input.requestedHostId, path:input.path, freeBytes:Number(fs.bavail)*Number(fs.bsize), totalBytes:Number(fs.blocks)*Number(fs.bsize),
    ...(input.machine ? { machine:await readMachineFacts() } : {}) };
};

/**
 * Writer worktrees live in ~/.lane-pilot/worktrees on the host. BB refuses to start a thread in a folder inside its
 * own storage that is not one of its environments (HTTP 409 «Workspace path is inside bb-managed storage»), which
 * is where the plugin's data dir is: every SelfyStudio writer on OVH failed to spawn that way on 2026-10-02.
 */
export const laneWorktreeRoot = () => join(homedir(), ".lane-pilot", "worktrees");

export const gitCreateWorktree: ExperimentalHostRpcHandlers<typeof hostContract>["gitCreateWorktree"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  ...await createWorktree({basePath:input.basePath,name:input.name,...(input.commit?{commit:input.commit}:{}),
    targetPath:join(laneWorktreeRoot(),input.name,basename(input.basePath))}),
});

export const gitDocsScope: ExperimentalHostRpcHandlers<typeof hostContract>["gitDocsScope"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  ...await readGitDocsScope({projectCwd:input.projectCwd,sinceEpochMs:input.sinceEpochMs,base:input.base,docsDir:input.docsDir,exclude:input.exclude}),
});

export const docsWorthinessFacts: ExperimentalHostRpcHandlers<typeof hostContract>["docsWorthinessFacts"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId, ...await readDocsWorthinessFacts({projectCwd:input.projectCwd}),
});

export const gitRevertPaths: ExperimentalHostRpcHandlers<typeof hostContract>["gitRevertPaths"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId, ...await revertPaths({projectCwd:input.projectCwd,paths:input.paths}),
});

export const gitUndoCheckWrites: ExperimentalHostRpcHandlers<typeof hostContract>["gitUndoCheckWrites"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  ...await undoCheckWrites({projectCwd:input.projectCwd,keep:input.keep,ownsPaths:input.ownsPaths,neverTouch:input.neverTouch,bookkeeping:input.bookkeeping}),
});

const jevSource = (input: { jevApiKey?: string; jevProvider?: "openlux" | "typesafe" }) => ({ jevApiKey: input.jevApiKey, jevProvider: input.jevProvider });

export const docsAnchors: ExperimentalHostRpcHandlers<typeof hostContract>["docsAnchors"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId, ...await buildDocsAnchors({projectCwd:input.projectCwd,pages:input.pages,prefix:input.prefix,exclude:input.exclude,workspaces:input.workspaces,...jevSource(input)}),
});

export const docsFlows: ExperimentalHostRpcHandlers<typeof hostContract>["docsFlows"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId, ...await buildDocsFlows({projectCwd:input.projectCwd,workspaces:input.workspaces,keep:input.keep,...jevSource(input)}),
});

export const docsDepth: ExperimentalHostRpcHandlers<typeof hostContract>["docsDepth"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId, ...await readDocsDepth({projectCwd:input.projectCwd,pages:input.pages,core:input.core,...jevSource(input)}),
});

export const docsVerifyCitations: ExperimentalHostRpcHandlers<typeof hostContract>["docsVerifyCitations"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId, ...await verifyDocsCitations({projectCwd:input.projectCwd,pages:input.pages,related:input.related,...jevSource(input)}),
});

export const docsStalenessHandler: ExperimentalHostRpcHandlers<typeof hostContract>["docsStaleness"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  ...await docsStaleness({projectCwd:input.projectCwd,base:input.base,changed:input.changed,pages:input.pages,...jevSource(input)}),
});

export const docsLineCounts: ExperimentalHostRpcHandlers<typeof hostContract>["docsLineCounts"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  counts:await readDocsLineCounts({projectCwd:input.projectCwd,files:input.files}),
});

export const gitCommitDocs: ExperimentalHostRpcHandlers<typeof hostContract>["gitCommitDocs"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  ...await commitDocs({projectCwd:input.projectCwd,paths:input.paths,message:input.message}),
});

export const gitOwnershipChanges: ExperimentalHostRpcHandlers<typeof hostContract>["gitOwnershipChanges"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  ...await gitOwnershipChangedPaths({projectCwd:input.projectCwd,baseSha:input.baseSha,compareCommitted:input.compareCommitted,unfiltered:input.unfiltered,bookkeeping:input.bookkeeping}),
});

export const readOpenCodeTelemetry: ExperimentalHostRpcHandlers<typeof hostContract>["readOpenCodeTelemetry"] = async (input) => {
  const rootInfo = await lstat(input.projectCwd);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("telemetry project root must be a real directory");
  const rootReal = await realpath(input.projectCwd);
  const normalized = input.relativePath.replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (isAbsolute(input.relativePath) || input.relativePath.includes("\\") || normalized.split("/").includes("..")
    || segments.some((segment) => !segment || segment === ".") || /^[A-Za-z]:/.test(normalized)
    || !normalized.endsWith(".jsonl") || normalized.length > 512) {
    throw new Error("telemetry path must be a bounded project-relative .jsonl path");
  }
  const fullPath = join(rootReal, normalized);
  let cursor = rootReal;
  for (const segment of normalized.split("/")) {
    cursor = join(cursor, segment);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new Error("telemetry path cannot traverse a symlink");
    if (cursor !== fullPath && !info.isDirectory()) throw new Error("telemetry path parent must be a directory");
    if (cursor === fullPath && !info.isFile()) throw new Error("telemetry path must be a regular file");
  }
  const actual = await realpath(fullPath);
  const rel = relative(rootReal, actual);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("telemetry path escaped the task workspace");
  const info = await lstat(actual);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("telemetry path must be a regular file");
  if (info.size > 262144) throw new Error("telemetry log exceeds 262144 bytes");
  const bytes = await readFile(actual);
  let content: string;
  try { content = new TextDecoder("utf-8", { fatal:true }).decode(bytes); }
  catch { throw new Error("telemetry log is not valid UTF-8"); }
  return { hostId:process.env.BB_HOST_ID ?? input.requestedHostId, relativePath:normalized,
    size:bytes.byteLength, sha256:sha256Hex(bytes), content };
};

export const readBoundedFile: ExperimentalHostRpcHandlers<typeof hostContract>["readBoundedFile"] = async (input) => {
  const workerHost = process.env.BB_HOST_ID?.trim();
  if (workerHost && workerHost !== input.requestedHostId) {
    throw new Error("lane_pilot_read_host_mismatch");
  }
  return readBoundedWorkspaceFile({
    hostId: workerHost || input.requestedHostId,
    projectCwd: input.projectCwd,
    relativePath: input.relativePath,
    offset: input.offset,
    maxLines: input.maxLines,
  });
};

export const listDocsPages: ExperimentalHostRpcHandlers<typeof hostContract>["listDocsPages"] = async (input) => {
  const root = await lstat(input.projectCwd);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("docs project root must be a real directory");
  const pages:Array<{path:string;modifiedAt:number;sha256:string;content:string}> = [];
  const oversized:string[] = [];
  const visit = async (dir:string):Promise<void> => {
    for (const entry of await readdir(dir,{withFileTypes:true})) {
      const path = join(dir,entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { await visit(path); continue; }
      if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
      const rel = relative(input.projectCwd,path).split(sep).join("/");
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      const bytes = await readFile(path);
      // The nightly pass reports an oversized page to the folder that owns it instead of failing every folder.
      if (bytes.byteLength > 40_000) { if (input.skipOversized) { oversized.push(rel); continue; } throw new Error(`docs page exceeds 40000 bytes: ${rel}`); }
      pages.push({path:rel,modifiedAt:Math.trunc(info.mtimeMs),sha256:sha256Hex(bytes),content:bytes.toString("utf8")});
      if (pages.length > 5000) throw new Error("docs inventory exceeds 5000 markdown files; reduce the source tree before running maintenance");
    }
  };
  // The root docs and apps/ by default; the nightly pass names every docs folder of a monorepo.
  for (const name of input.roots ?? ["docs","apps"]) {
    const path=join(input.projectCwd,name);
    try { const info=await lstat(path); if(info.isDirectory()&&!info.isSymbolicLink()) await visit(path); }
    catch(cause) { if((cause as NodeJS.ErrnoException).code!=="ENOENT") throw cause; }
  }
  return {hostId:input.requestedHostId,pages,...(input.skipOversized?{oversized}:{})};
};

/** The project's own workflows: the `.json` files of `<project>/.lane-pilot/workflows`, small regular files only. A missing folder is an empty list. */
export const listWorkflowFiles: ExperimentalHostRpcHandlers<typeof hostContract>["listWorkflowFiles"] = async (input) => {
  const dir = join(input.projectCwd, ".lane-pilot", "workflows");
  let names: string[] = [];
  try { names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort(); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT" && (cause as NodeJS.ErrnoException).code !== "ENOTDIR") throw cause; }
  const files: Array<{ path: string; content: string }> = [];
  for (const name of names.slice(0, 200)) {
    const info = await lstat(join(dir, name));
    if (!info.isFile() || info.isSymbolicLink() || info.size > 262_144) continue;
    files.push({ path: name, content: await readFile(join(dir, name), "utf8") });
  }
  return { hostId: process.env.BB_HOST_ID ?? input.requestedHostId, files };
};

type MarkdownWrite = Parameters<ExperimentalHostRpcHandlers<typeof hostContract>["applyOnboardingPages"]>[0];

/** Onboarding previews stay small; the docs builders rewrite whole pages of up to 40000 bytes. */
export const applyOnboardingPages: ExperimentalHostRpcHandlers<typeof hostContract>["applyOnboardingPages"] = async (input) =>
  casWriteMarkdown(input, 32_000, (path) => path.startsWith("docs/") || path.startsWith("apps/"));

/** The builders write into any docs folder: the root docs/ or a monorepo workspace's own docs/. */
export const writeDocsPages: ExperimentalHostRpcHandlers<typeof hostContract>["writeDocsPages"] = async (input) =>
  casWriteMarkdown({ ...input, confirmed:true }, 2_000_000, (path) => /(^|\/)docs\//.test(path));

/** The permit channel on this machine: every ticket a writer filed that has no answer yet. */
export const listPermitTickets: ExperimentalHostRpcHandlers<typeof hostContract>["listPermitTickets"] = async (input) => {
  const hostId = process.env.BB_HOST_ID ?? input.requestedHostId;
  const root = join(homedir(), ".agents", "permits");
  const tickets: Array<{ session: string; ticket: string; category: string; command: string; cwd: string; at: number }> = [];
  for (const session of await readdir(root).catch(() => [] as string[])) {
    for (const name of await readdir(join(root, session)).catch(() => [] as string[])) {
      if (!name.endsWith(".ticket.json")) continue;
      const id = name.slice(0, -".ticket.json".length);
      if (await stat(join(root, session, `${id}.answer.json`)).then(() => true, () => false)) continue;
      const raw = await readFile(join(root, session, name), "utf8").then((text) => JSON.parse(text) as Record<string, unknown>, () => null);
      if (raw) tickets.push({ session, ticket: id, category: String(raw.category ?? ""), command: String(raw.command ?? "").slice(0, 2000), cwd: String(raw.cwd ?? ""), at: Number(raw.at ?? 0) });
    }
  }
  return { hostId, tickets: tickets.slice(0, 100) };
};

/** The PM's answer to one permit ticket. */
export const answerPermit: ExperimentalHostRpcHandlers<typeof hostContract>["answerPermit"] = async (input) => {
  const hostId = process.env.BB_HOST_ID ?? input.requestedHostId;
  const folder = join(homedir(), ".agents", "permits", input.session);
  if (!await stat(join(folder, `${input.ticket}.ticket.json`)).then(() => true, () => false)) return { hostId, written: false };
  const temp = join(folder, `.${input.ticket}.${randomUUID().slice(0, 8)}`);
  const handle = await open(temp, "w");
  try { await handle.writeFile(JSON.stringify({ decision: input.decision, why: input.why, at: Date.now() / 1000 })); } finally { await handle.close(); }
  await rename(temp, join(folder, `${input.ticket}.answer.json`));
  return { hostId, written: true };
};

/** The subscription windows the statusline cached on this machine: five hours, seven days, seven days of Opus (utilization in percent). */
export const readUsageWindows: ExperimentalHostRpcHandlers<typeof hostContract>["readUsageWindows"] = async (input) => {
  const hostId = process.env.BB_HOST_ID ?? input.requestedHostId;
  const file = join(process.env.LANE_STATUSLINE_CACHE ?? join(homedir(), ".agents", "statusline"), "last_usage.json");
  const raw = await readFile(file, "utf8").then((text) => JSON.parse(text) as Record<string, unknown>, () => null);
  const usage = (raw?.usage ?? {}) as Record<string, { utilization?: unknown; resets_at?: unknown }>;
  const windows: Record<string, { utilization: number; resetsAt: string | null }> = {};
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value?.utilization === "number") windows[key] = { utilization: value.utilization, resetsAt: typeof value.resets_at === "string" ? value.resets_at : null };
  }
  return { hostId, at: typeof raw?.at === "string" ? raw.at : null, windows };
};

/** Close exactly that line: the backlog item's meta.yaml gets `status: done`; a file with no or two status lines is refused, not guessed. */
export const closeBacklogItem: ExperimentalHostRpcHandlers<typeof hostContract>["closeBacklogItem"] = async (input) => {
  const hostId = process.env.BB_HOST_ID ?? input.requestedHostId;
  const file = join(await realpath(input.projectCwd), ".agents", "todos", "items", input.id, "meta.yaml");
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) return { hostId, status: "refused", reason: `no ${relative(input.projectCwd, file)}` };
  const lines = text.split("\n");
  const at = lines.flatMap((line, index) => (/^status\s*:/.test(line) ? [index] : []));
  if (at.length !== 1) return { hostId, status: "refused", reason: `${at.length} status lines in meta.yaml; expected exactly one` };
  if (/^status\s*:\s*done\s*$/.test(lines[at[0]!]!)) return { hostId, status: "already", reason: null };
  lines[at[0]!] = "status: done";
  const temp = `${file}.lp-${randomUUID().slice(0, 8)}`;
  const handle = await open(temp, "w");
  try { await handle.writeFile(lines.join("\n")); } finally { await handle.close(); }
  await rename(temp, file);
  return { hostId, status: "closed", reason: null };
};

/** Is the check command runnable: each program found on PATH, among the user's tool bins, or in the check folder's node_modules/.bin. */
export const whichPrograms: ExperimentalHostRpcHandlers<typeof hostContract>["whichPrograms"] = async (input) => {
  const dirs = [join(input.cwd, "node_modules", ".bin"), ...userToolBins(), ...(process.env.PATH ?? "").split(delimiter)].filter(Boolean);
  const found: Record<string, boolean> = {};
  for (const program of input.programs) {
    let hit = false;
    for (const dir of dirs) {
      if (await access(join(dir, program), fsConstants.X_OK).then(() => true, () => false)) { hit = true; break; }
    }
    found[program] = hit;
  }
  return { hostId: process.env.BB_HOST_ID ?? input.requestedHostId, found };
};

const LIST_FOLDER_MAX = 500;

/** The file names in each folder, for the contract lint's tests next to owned code («shoot.ts» → «__tests__/shoot-seo-audit.test.ts»). */
export const listFolders: ExperimentalHostRpcHandlers<typeof hostContract>["listFolders"] = async (input) => ({
  hostId: process.env.BB_HOST_ID ?? input.requestedHostId,
  entries: await Promise.all(input.paths.map(async (path) => {
    const names = await readdir(path, { withFileTypes:true })
      .then((entries) => entries.filter((entry) => entry.isFile() || entry.isSymbolicLink()).map((entry) => entry.name).sort(), () => [] as string[]);
    return { path, names:names.slice(0, LIST_FOLDER_MAX), truncated:names.length > LIST_FOLDER_MAX };
  })),
});

/** The phase book (BOOK.md) and the phase's own files, only inside `.agents/phases/<phase-id>/` (src/rooms/phase). */
export const writePhaseBook: ExperimentalHostRpcHandlers<typeof hostContract>["writePhaseBook"] = async (input) =>
  casWriteMarkdown({ ...input, confirmed:true }, 2_000_000, (path) => (/^\.agents\/phases\/ph_[a-z0-9]{6,}\/[^/]+(\/[^/]+)*$/.test(path) || /^\.agents\/planning\/(STATE|ROADMAP)\.md$/.test(path)) && !path.includes(".."));

/**
 * Fresh codex home per task, seeded (SMA: Fresh codex home per task, Seed the codex home): a writer of the strict worker mode gets its own
 * CODEX_HOME, so no task reads another task's sessions and history; config.toml and AGENTS.md are copied, auth.json is linked (one login
 * that refreshes in one place).
 */
export const prepareWorkerHome: ExperimentalHostRpcHandlers<typeof hostContract>["prepareWorkerHome"] = async (input) => {
  const { mkdir: mk, copyFile, symlink: link, access: can } = await import("node:fs/promises");
  const { homedir: home } = await import("node:os");
  const { join: at } = await import("node:path");
  const source = process.env.CODEX_HOME?.trim() || at(home(), ".codex");
  const codexHome = at(home(), ".lane-pilot", "codex-homes", input.key);
  await mk(codexHome, { recursive: true });
  const seeded: string[] = [];
  for (const name of ["config.toml", "AGENTS.md"]) {
    if (await can(at(source, name)).then(() => true, () => false) && !await can(at(codexHome, name)).then(() => true, () => false)) { await copyFile(at(source, name), at(codexHome, name)); seeded.push(name); }
  }
  if (await can(at(source, "auth.json")).then(() => true, () => false) && !await can(at(codexHome, "auth.json")).then(() => true, () => false)) { await link(at(source, "auth.json"), at(codexHome, "auth.json")); seeded.push("auth.json"); }
  return { codexHome, seeded };
};

/** A forge draft lands only under `.agents/forge/(skills|roles|workflows)/<name>/` (src/rooms/front, src/rooms/forge). */
export const writeForgeDraft: ExperimentalHostRpcHandlers<typeof hostContract>["writeForgeDraft"] = async (input) =>
  casWriteMarkdown({ ...input, confirmed:true }, 60_000, (path) => /^\.agents\/forge\/(skills|roles|workflows)\/[a-z][a-z0-9-]{1,47}\/[A-Za-z0-9._-]{1,60}$/.test(path));

/** An enabled forge draft lands only at `.claude/skills/<name>/SKILL.md` or `.claude/agents/<name>.md` of the project (src/rooms/forge). */
export const writeForgeEnabled: ExperimentalHostRpcHandlers<typeof hostContract>["writeForgeEnabled"] = async (input) =>
  casWriteMarkdown({ ...input, confirmed:true }, 60_000, (path) => /^\.claude\/(skills\/[a-z][a-z0-9-]{1,47}\/SKILL\.md|agents\/[a-z][a-z0-9-]{1,47}\.md)$/.test(path));

/** Writes one chain file into the project's own `.lane-pilot/workflows` folder, which must not be a link out of the project. */
export const writeWorkflowFile: ExperimentalHostRpcHandlers<typeof hostContract>["writeWorkflowFile"] = async (input) => {
  const rootInfo = await lstat(input.projectCwd);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("workflow project root must be a real directory");
  const root = await realpath(input.projectCwd);
  let cursor = root;
  for (const segment of [".lane-pilot", "workflows"]) {
    cursor = join(cursor, segment);
    const info = await lstat(cursor).catch((cause: NodeJS.ErrnoException) => { if (cause.code === "ENOENT") return null; throw cause; });
    if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new Error(`workflow folder must be a real directory: ${segment}`);
  }
  const written = await casWriteWorkflowFile(cursor, input.id, input.content, input.expectedSha256);
  return { hostId: process.env.BB_HOST_ID ?? input.requestedHostId, status: written.status, path: `.lane-pilot/workflows/${input.id}.json`, beforeSha256: written.beforeSha256, afterSha256: written.afterSha256, reason: written.reason };
};

async function casWriteMarkdown(input:MarkdownWrite, maxTotalBytes:number, inScope:(path:string) => boolean):Promise<Awaited<ReturnType<ExperimentalHostRpcHandlers<typeof hostContract>["applyOnboardingPages"]>>> {
  const suppliedPreviewSha256=sha256Hex(JSON.stringify(input.edits));
  if(suppliedPreviewSha256!==input.previewSha256) return {hostId:process.env.BB_HOST_ID??input.requestedHostId,previewSha256:input.previewSha256,status:"blocked",writes:[],reason:"onboarding preview hash did not match supplied edits"};
  const rootInfo=await lstat(input.projectCwd);
  if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink()) throw new Error("onboarding project root must be a real directory");
  const root=await realpath(input.projectCwd);
  const totalBytes=input.edits.reduce((sum,edit)=>sum+Buffer.byteLength(edit.content,"utf8"),0);
  if(totalBytes>maxTotalBytes) throw new Error(`markdown write exceeds ${maxTotalBytes} total bytes`);
  const targets:Array<{path:string;fullPath:string;expectedSha256:string|null;beforeMode:number|null}> = [];
  for(const edit of input.edits){
    const normalized=edit.path;
    const segments=normalized.split("/");
    if(normalized.includes("\\")||isAbsolute(normalized)||segments.some((part)=>!part||part==="."||part==="..")
      ||!(inScope(normalized)&&/\.md$/i.test(normalized))) {
      throw new Error(`onboarding path is outside Markdown docs scope: ${normalized}`);
    }
    // Onboarding creates docs/ in a project that has none: missing parents are made at write time;
    // the ones that exist must be real directories inside the project.
    let cursor=root, parentMissing=false;
    for(const segment of segments.slice(0,-1)){
      cursor=join(cursor,segment);
      const info=await lstat(cursor).catch((cause)=>{
        if((cause as NodeJS.ErrnoException).code==="ENOENT") return null;
        throw cause;
      });
      if(!info){ parentMissing=true; break; }
      if(info.isSymbolicLink()||!info.isDirectory()) throw new Error(`onboarding parent must be a real directory: ${normalized}`);
    }
    const fullPath=join(root,...segments);
    if(!parentMissing){
      const parentReal=await realpath(dirname(fullPath));
      const parentRelative=relative(root,parentReal);
      if(parentRelative.startsWith("..")||isAbsolute(parentRelative)) throw new Error(`onboarding parent escaped the project: ${normalized}`);
    }
    let beforeMode:number|null=null;
    try{
      const info=await lstat(fullPath);
      if(info.isSymbolicLink()||!info.isFile()) throw new Error(`onboarding target must be a regular file: ${normalized}`);
      const currentHash=sha256Hex(await readFile(fullPath));
      if(edit.expectedSha256===null||currentHash!==edit.expectedSha256){
        return {hostId:process.env.BB_HOST_ID??input.requestedHostId,previewSha256:input.previewSha256,status:"conflict",writes:[],reason:`onboarding expected hash changed: ${normalized}`};
      }
      beforeMode=info.mode&0o777;
    }catch(cause){
      if((cause as NodeJS.ErrnoException).code!=="ENOENT") throw cause;
      if(edit.expectedSha256!==null) return {hostId:process.env.BB_HOST_ID??input.requestedHostId,previewSha256:input.previewSha256,status:"conflict",writes:[],reason:`onboarding target disappeared: ${normalized}`};
    }
    targets.push({path:normalized,fullPath,expectedSha256:edit.expectedSha256,beforeMode});
  }
  const writes:Array<{path:string;beforeSha256:string|null;afterSha256:string|null;status:"applied"|"conflict"|"blocked";reason:string|null}> = [];
  for(let index=0;index<input.edits.length;index++){
    const edit=input.edits[index]!,target=targets[index]!;
    let tempPath:string|undefined;
    try{
      const currentInfo=await lstat(target.fullPath).catch((cause)=>{
        if((cause as NodeJS.ErrnoException).code==="ENOENT") return null;
        throw cause;
      });
      const currentHash=currentInfo?sha256Hex(await readFile(target.fullPath)):null;
      if((currentInfo?.isSymbolicLink()??false)||currentHash!==target.expectedSha256){
        writes.push({path:target.path,beforeSha256:currentHash,afterSha256:currentHash,status:"conflict",reason:"target changed after onboarding preflight"});
        return {hostId:process.env.BB_HOST_ID??input.requestedHostId,previewSha256:input.previewSha256,status:writes.length===1?"conflict":"blocked",writes,reason:"onboarding compare-and-swap changed during apply"};
      }
      const bytes=Buffer.from(edit.content,"utf8");
      await mkdir(dirname(target.fullPath),{recursive:true});
      tempPath=join(dirname(target.fullPath),`.${basename(target.fullPath)}.lane-pilot-${randomUUID()}.tmp`);
      const handle=await open(tempPath,"wx",target.beforeMode??0o600);
      try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
      if(target.beforeMode!==null) await chmod(tempPath,target.beforeMode);
      const latestInfo=await lstat(target.fullPath).catch((cause)=>{
        if((cause as NodeJS.ErrnoException).code==="ENOENT") return null;
        throw cause;
      });
      const latestHash=latestInfo?sha256Hex(await readFile(target.fullPath)):null;
      if((latestInfo?.isSymbolicLink()??false)||latestHash!==target.expectedSha256){
        await unlink(tempPath).catch(()=>undefined);tempPath=undefined;
        writes.push({path:target.path,beforeSha256:latestHash,afterSha256:latestHash,status:"conflict",reason:"target changed before atomic replacement"});
        return {hostId:process.env.BB_HOST_ID??input.requestedHostId,previewSha256:input.previewSha256,status:writes.length===1?"conflict":"blocked",writes,reason:"onboarding compare-and-swap changed during apply"};
      }
      await rename(tempPath,target.fullPath);tempPath=undefined;
      const afterSha256=sha256Hex(await readFile(target.fullPath));
      if(afterSha256!==sha256Hex(bytes)) throw new Error("onboarding atomic-write readback hash mismatch");
      writes.push({path:target.path,beforeSha256:target.expectedSha256,afterSha256,status:"applied",reason:null});
    }catch(cause){
      if(tempPath) await unlink(tempPath).catch(()=>undefined);
      const reason=cause instanceof Error?cause.message:String(cause);
      writes.push({path:target.path,beforeSha256:target.expectedSha256,afterSha256:null,status:"blocked",reason});
      return {hostId:process.env.BB_HOST_ID??input.requestedHostId,previewSha256:input.previewSha256,status:writes.some((row)=>row.status==="applied")?"blocked":"blocked",writes,reason};
    }
  }
  return {hostId:process.env.BB_HOST_ID??input.requestedHostId,previewSha256:input.previewSha256,status:"applied",writes,reason:null};
};

export const coexistenceOperation: ExperimentalHostRpcHandlers<typeof hostContract>["coexistenceOperation"] = async (input) => (
  runCoexistenceOperation({
    projectId: input.projectId,
    hostId: input.requestedHostId,
    operation: input.operation,
    manager: input.manager,
    path: input.path,
    expectedSha256: input.expectedSha256,
    snapshotId: input.snapshotId,
    targetSha: input.targetSha,
    confirmExternalOps: input.confirmExternalOps,
  })
);

export const detect: ExperimentalHostRpcHandlers<typeof hostContract>["detect"] = async (input) => {
  const detected = await detectStack(ctx(input));
  return {
    hostId: detected.hostId,
    laneStack: detected.laneStack,
    openCode: detected.openCode,
    workspace: detected.workspace,
    targetSha: detected.targetSha,
    matchesTarget: detected.matchesTarget,
    scenario: detected.scenario,
  };
};

export const snapshot: ExperimentalHostRpcHandlers<typeof hostContract>["snapshot"] = async (input) => (
  snapshotStack(ctx(input))
);

export const install: ExperimentalHostRpcHandlers<typeof hostContract>["install"] = async (input) => (
  installStack(ctx(input))
);

export const rollback: ExperimentalHostRpcHandlers<typeof hostContract>["rollback"] = async (input) => (
  rollbackStack(ctx(input))
);

export const importConfig: ExperimentalHostRpcHandlers<typeof hostContract>["importConfig"] = async (input) => (
  importConfigStack(ctx(input))
);

export const connectOpencode: ExperimentalHostRpcHandlers<typeof hostContract>["connectOpencode"] = async (input) => (
  connectOpencodeStack(ctx(input))
);

export const runScript: ExperimentalHostRpcHandlers<typeof hostContract>["runScript"] = async (input) => (
  runScriptOnHost(input)
);

export const runCommand: ExperimentalHostRpcHandlers<typeof hostContract>["runCommand"] = async (input) => (
  runCommandOnHost(input)
);

export const runSandboxedCommand: ExperimentalHostRpcHandlers<typeof hostContract>["runSandboxedCommand"] = async (input) => (
  runSandboxedCommandOnHost(input)
);

/**
 * This machine's address in the private WireGuard network (wg*, utun*, tun*, tailscale*): another machine's browser
 * reaches a dev server here at that address, without a public tunnel.
 */
export const vpnAddress: ExperimentalHostRpcHandlers<typeof hostContract>["vpnAddress"] = async (input) => {
  const hostId = process.env.BB_HOST_ID ?? input.requestedHostId;
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    if (!/^(wg|utun|tun|tailscale)/.test(name)) continue;
    const ipv4 = entries?.find((entry) => entry.family === "IPv4" && !entry.internal
      && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(entry.address));
    if (ipv4) return { hostId, address:ipv4.address, interface:name };
  }
  return { hostId, address:null, interface:null };
};

export const sandboxCommandLine: ExperimentalHostRpcHandlers<typeof hostContract>["sandboxCommandLine"] = async (input) => (
  prepareSandboxedCommandLine(input)
);

export const sandboxRelease: ExperimentalHostRpcHandlers<typeof hostContract>["sandboxRelease"] = async (input) => {
  await releaseSandboxedCommandLine({ tempPath:input.tempPath, created:input.created });
  return { hostId:process.env.BB_HOST_ID ?? input.requestedHostId, released:true };
};

export const runBrowserQa: ExperimentalHostRpcHandlers<typeof hostContract>["runBrowserQa"] = async (input) => (
  runBrowserQaOnHost(input)
);

export const probeBrowserQaTarget: ExperimentalHostRpcHandlers<typeof hostContract>["probeBrowserQaTarget"] = async (input) => {
  const hostId = process.env.BB_HOST_ID ?? input.requestedHostId;
  let workspaceRealPath: string;
  try {
    workspaceRealPath = await realpath(input.workspacePath);
  } catch {
    throw new Error("browser_qa_workspace_unreachable");
  }
  const target = new URL(input.url);
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) {
    throw new Error("browser_qa_url_must_be_http_without_userinfo");
  }
  await new Promise<void>((resolve, reject) => {
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send({
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: "GET",
      timeout: 5000,
    }, (res) => {
      res.resume();
      resolve();
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("browser_qa_url_timeout"));
    });
    req.on("error", (cause) => {
      reject(new Error(`browser_qa_url_unreachable:${cause instanceof Error ? cause.message : String(cause)}`));
    });
    req.end();
  });
  return { hostId, workspaceRealPath, url: input.url, processHostId: hostId };
};

const PLAN_EFFORT_QUESTION = {
  type:"choice",
  instructions:"Reasoning effort this turn needs. Pick the cheapest that still solves the task.",
  criteria:{
    low:"obvious, mechanical, follow an existing pattern; extra thinking is waste",
    medium:"normal implementation with local scope",
    high:"must think carefully; many tradeoffs or failure modes",
    xhigh:"deep architecture, concurrency, security, or wide blast radius; cheaper effort will miss it",
  },
} as const;

export const classifyPlan: ExperimentalHostRpcHandlers<typeof hostContract>["classifyPlan"] = async (input) => {
  const hostId = process.env.BB_HOST_ID ?? input.requestedHostId;
  const planSha256 = sha256Hex(input.plan);
  const sourceLength = Buffer.byteLength(input.plan, "utf8");
  const auth = await jevCallFor(input);
  const apiKey = auth?.key ?? "";
  const provider = auth?.provider ?? JEV_PROVIDERS.typesafe;
  const payload = { model:provider.model, state:{ task:input.plan }, questions:{ effort:PLAN_EFFORT_QUESTION } };
  const body = JSON.stringify(payload);
  const decodedPlan = (JSON.parse(body) as { state:{ task:string } }).state.task;
  const sentPlanSha256 = sha256Hex(decodedPlan);
  const sentLength = Buffer.byteLength(decodedPlan, "utf8");
  const transportProof = { planSha256, sentPlanSha256, sourceLength, sentLength };
  if (sentPlanSha256 !== planSha256 || sentLength !== sourceLength) {
    return { hostId, status:"error", effort:null, reason:"plan_serialization_mismatch", ...transportProof };
  }
  if (!apiKey) return { hostId, status:"disabled", effort:null, reason:"missing_typesafe_api_key",
    planSha256, sentPlanSha256:null, sourceLength, sentLength:null };
  try {
    const response = await fetch(provider.url, {
      method:"POST",
      headers:{ authorization:`Bearer ${apiKey}`, "content-type":"application/json" },
      body,
      signal:AbortSignal.timeout(2500 + provider.timeoutPadMs),
    });
    if (!response.ok) return { hostId, status:"error", effort:null, reason:`http_${response.status}`, ...transportProof };
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" || !("answers" in value)) {
      return { hostId, status:"error", effort:null, reason:"invalid_response", ...transportProof };
    }
    const answers = (value as { answers?: unknown }).answers;
    const effort = answers && typeof answers === "object"
      ? (answers as Record<string, { choice?: unknown }>).effort?.choice
      : undefined;
    if (typeof effort !== "string") return { hostId, status:"error", effort:null, reason:"missing_effort_answer", ...transportProof };
    return { hostId, status:"ok", effort, reason:null, ...transportProof };
  } catch (cause) {
    const reason = cause instanceof Error && cause.name === "TimeoutError" ? "timeout" : "api_request_failed";
    return { hostId, status:reason === "timeout" ? "timeout" : "error", effort:null, reason, ...transportProof };
  }
};

/** One System One call with several choice questions over a JSON state; the council's moderator and the seats' impulse to speak use it. */
export const councilJudge: ExperimentalHostRpcHandlers<typeof hostContract>["councilJudge"] = async (input) => {
  const hostId = process.env.BB_HOST_ID ?? input.requestedHostId;
  const auth = await jevCallFor(input);
  const apiKey = auth?.key ?? "";
  if (!apiKey || !auth) return { hostId, status:"disabled", answers:{}, reason:"missing_typesafe_api_key" };
  let state: unknown = input.state;
  try { state = JSON.parse(input.state); } catch { /* a plain text state is allowed */ }
  const questions = Object.fromEntries(Object.entries(input.questions).map(([name, question]) => [name, { type:"choice", instructions:question.instructions, criteria:question.criteria }]));
  try {
    const provider = auth.provider;
    const response = await fetch(provider.url, {
      method:"POST",
      headers:{ authorization:`Bearer ${apiKey}`, "content-type":"application/json" },
      body:JSON.stringify({ model:provider.model, state, questions }),
      signal:AbortSignal.timeout((input.timeoutMs ?? 4000) + provider.timeoutPadMs),
    });
    if (!response.ok) return { hostId, status:"error", answers:{}, reason:`http_${response.status}` };
    const value: unknown = await response.json();
    const raw = value && typeof value === "object" ? (value as { answers?: unknown }).answers : undefined;
    if (!raw || typeof raw !== "object") return { hostId, status:"error", answers:{}, reason:"invalid_response" };
    const answers: Record<string, string> = {};
    const confidence: Record<string, number> = {};
    const probabilities: Record<string, Record<string, number>> = {};
    for (const [name, answer] of Object.entries(raw as Record<string, { choice?: unknown; confidence?: unknown; probabilities?: unknown }>)) {
      if (answer && typeof answer === "object" && typeof answer.choice === "string") {
        answers[name] = answer.choice;
        if (typeof answer.confidence === "number") confidence[name] = answer.confidence;
        if (answer.probabilities && typeof answer.probabilities === "object") {
          probabilities[name] = Object.fromEntries(Object.entries(answer.probabilities as Record<string, unknown>).filter(([, value]) => typeof value === "number")) as Record<string, number>;
        }
      }
    }
    return { hostId, status:"ok", answers, confidence, probabilities, reason:null };
  } catch (cause) {
    const timeout = cause instanceof Error && cause.name === "TimeoutError";
    return { hostId, status:timeout ? "timeout" : "error", answers:{}, reason:timeout ? "timeout" : "api_request_failed" };
  }
};

export const inspectCritiqueCoverage: ExperimentalHostRpcHandlers<typeof hostContract>["inspectCritiqueCoverage"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  ...await scanCritiqueCoverage({workspacePath:input.workspacePath,plan:input.plan,
    tasks:input.tasks.map((task)=>({id:task.id,lane:task.lane,owns_paths:task.ownsPaths,has_verification:task.hasVerification,
      verification:task.verification.map((command)=>({command:command.command,timeout_sec:command.timeoutSec}))}))}),
});

export const writePmSettings: ExperimentalHostRpcHandlers<typeof hostContract>["writePmSettings"] = async (input) => (
  writePmSettingsOnHost(input)
);

export const discoverClaudeAgentsHost: ExperimentalHostRpcHandlers<typeof hostContract>["discoverClaudeAgents"] = async (input) => (
  discoverClaudeAgents(input.cwd)
);

export const prepareNativeClaudeHost: ExperimentalHostRpcHandlers<typeof hostContract>["prepareNativeClaude"] = async (input, context) => (
  prepareNativeClaude({
    cwd: input.cwd,
    agentId: input.agentId,
    agentsJson: input.agentsJson,
    dataDir: context.experimental_paths.dataDir,
    signal: context.signal,
  })
);

export const prepareBbShimHost: ExperimentalHostRpcHandlers<typeof hostContract>["prepareBbShim"] = async (_input, context) => (
  prepareBbShim({ dataDir: context.experimental_paths.dataDir })
);

export const snapshotDryRun: ExperimentalHostRpcHandlers<typeof hostContract>["snapshotDryRun"] = async (input) => ({
  hostId: process.env.BB_HOST_ID ?? input.requestedHostId,
  entries: await Promise.all(input.paths.map(async (path) => {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        const target = await stat(path).then((followed) => followed.isFile() ? "file" as const : followed.isDirectory() ? "directory" as const : "other" as const, () => "missing" as const);
        return { path, kind:"symlink" as const, sha256:null, symlinkTarget:await readlink(path), targetKind:target };
      }
      if (info.isFile()) return { path, kind:"file" as const, sha256:await hashFile(path), symlinkTarget:null };
      if (info.isDirectory()) return { path, kind:"directory" as const, sha256:null, symlinkTarget:null };
      return { path, kind:"other" as const, sha256:null, symlinkTarget:null };
    } catch {
      return { path, kind:"missing" as const, sha256:null, symlinkTarget:null };
    }
  })),
});


/**
 * One browser goal through the jev-ultrafast runner, without a shell: the goal is an argument, never shell text.
 * The runner prints its steps and, last, one JSON line {status,url,actions}. Asynchronous, so the host worker keeps
 * serving writer checks while Chrome works.
 */
export const browserGoal: ExperimentalHostRpcHandlers<typeof hostContract>["browserGoal"] = async (input) => {
  // The computer-use launcher of this machine: LANE_PILOT_JEV_RUNNER, else the BB-сервис toolkit checkout.
  const candidates = process.env.LANE_PILOT_JEV_RUNNER ? [process.env.LANE_PILOT_JEV_RUNNER] : [join(homedir(), "Documents", "BB-сервис", "toolkit", "computer-use", "bin", "run")];
  let runner: string | null = null;
  for (const path of candidates) { if (await lstat(path).then(() => true, () => false)) { runner = path; break; } }
  if (!runner) return { hostId: process.env.BB_HOST_ID ?? input.requestedHostId, exitCode: 127, status: "no_runner", url: null, actions: null, title: null, text: null, log: `jev-ultrafast launcher not found; looked at ${candidates.join(", ")}` };
  const timeoutMs = (input.timeoutSec ?? 180) * 1000;
  const env = { ...process.env, PATH: [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean).join(":") };
  const { code, out } = await new Promise<{ code: number; out: string }>((resolveRun) => {
    execFile(runner, ["browser", "--url", input.url, "--goal", input.goal], { env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const status = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? 1 : 0;
      resolveRun({ code: status, out: `${stdout ?? ""}${stderr ? `\n${stderr}` : ""}${error && !stdout ? `\n${error.message}` : ""}` });
    });
  });
  let parsed: { status?: unknown; url?: unknown; actions?: unknown; title?: unknown; text?: unknown } = {};
  for (const line of out.trim().split("\n").reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try { parsed = JSON.parse(trimmed) as typeof parsed; break; } catch { continue; }
  }
  return {
    hostId: process.env.BB_HOST_ID ?? input.requestedHostId,
    exitCode: code,
    status: typeof parsed.status === "string" ? parsed.status : code === 0 ? "unknown" : "error",
    url: typeof parsed.url === "string" ? parsed.url : null,
    actions: typeof parsed.actions === "number" ? parsed.actions : null,
    title: typeof parsed.title === "string" ? parsed.title : null,
    text: typeof parsed.text === "string" ? parsed.text : null,
    // The steps only; the final JSON line (with the page text) is returned above, not twice.
    log: out.split("\n").filter((line) => !line.trim().startsWith("{")).join("\n").slice(-2000),
  };
};

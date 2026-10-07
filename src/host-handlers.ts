import { networkInterfaces } from "node:os";
import { createWorktree, integrateWorktree, prepareWorktree, removeLaneWorktree, syncWorktree, snapshotWorktree, type ReplayCheckOutcome } from "./verification/git-integrate";
import { bisectGateOnHost, runGateOnHost } from "./verification/integration-gate-host";
import { buildDocsAnchors, docsDepth as readDocsDepth, docsStaleness, jevApiKey, provideJevKey, verifyDocsCitations } from "./verification/docs-jev";
import { buildDocsFlows } from "./verification/docs-flows";
import { runStabilityDrill } from "./verification/stability-drill";
import { commitDocs, docsLineCounts as readDocsLineCounts, docsWorthinessFacts as readDocsWorthinessFacts, gitDocsScope as readGitDocsScope, revertPaths } from "./verification/git-docs";
import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { chmod, lstat, mkdir, open, stat, statfs, readFile, readlink, readdir, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { homedir } from "node:os";
import type { ExperimentalHostRpcHandlers } from "@get-bb/plugin-sdk";
import { hostContract } from "./contracts";
import { isEnvironmentCheckFailure } from "./failure-class";
import { readBoundedWorkspaceFile } from "./bounded-read";
import { casWriteWorkflowFile } from "./workflow/files";
import { inventoryCoexistence, runCoexistenceOperation } from "./coexistence";
import { runBrowserQaOnHost } from "./stages/browser-qa";
import { cancelHostJob, hostJobStatus, startHostJob } from "./jobs";
import { scanCritiqueCoverage } from "./stages/critique-coverage";
import { prepareSandboxedCommandLine, releaseSandboxedCommandLine, runSandboxedCommandOnHost } from "./verification/sandbox";
import { gitOwnershipChangedPaths, resolveGitOwnershipBase } from "./verification/git-ownership";
import { runCliOnHost, runCommandOnHost, writePmSettingsOnHost } from "./cli-run";
import { execFile } from "node:child_process";
import { discoverClaudeAgents, prepareNativeClaude } from "./native-claude-host";
import {
  connectOpencodeStack,
  detectStack,
  importConfigStack,
  installStack,
  rollbackStack,
  snapshotStack,
  type HostContext,
} from "./stack-ops";

async function hashFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
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
    ownsPaths:input.ownsPaths,
    replayCheck:input.replayChecks?()=>runReplayChecks(input.requestedHostId,input.replayChecks!):undefined}),
});

/**
 * The task's checks in the sandbox, in the attempt's worktree, while the integration holds the base checkout. The first red
 * one (twice red: a flaky one passes the second time) ends it. A check that cannot run (no sandbox backend, a folder gone)
 * says nothing about the code, so it blocks nothing; the post-merge check on main still runs.
 */
async function runReplayChecks(requestedHostId:string,checks:NonNullable<Parameters<ExperimentalHostRpcHandlers<typeof hostContract>["gitIntegrate"]>[0]["replayChecks"]>):Promise<ReplayCheckOutcome> {
  for(const check of checks.commands) {
    const run=()=>runSandboxedCommandOnHost({requestedHostId,workspacePath:checks.workspacePath,cwd:check.cwd,backend:checks.backend,command:check.command,timeoutSec:check.timeoutSec});
    try {
      let result=await run();
      if(result.exitCode!==0) result=await run();
      // The machine broke the check (root-owned files): no writer can fix that, so it does not hold the merge back.
      if(result.exitCode!==0&&isEnvironmentCheckFailure(result)) return {ok:true};
      if(result.exitCode!==0) return {ok:false,failed:[{command:check.command,exitCode:result.exitCode,stdout:result.stdout,stderr:result.stderr}]};
    } catch(cause) {
      console.warn(`lane-pilot: replay check could not run, the merge goes on: ${check.command}: ${cause instanceof Error?cause.message:String(cause)}`);
      return {ok:true};
    }
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

/** Background jobs (B4): ordinary short calls; the long work runs in a process of its own, see src/jobs.ts. */
export const jobStart: ExperimentalHostRpcHandlers<typeof hostContract>["jobStart"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  jobId:await startHostJob({kind:input.kind,input:input.input,timeoutSec:input.timeoutSec}),
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

export const gitWorktreeSnapshot: ExperimentalHostRpcHandlers<typeof hostContract>["gitWorktreeSnapshot"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  ...await snapshotWorktree({worktreePath:input.worktreePath,name:input.name,dir:join(homedir(),".lane-pilot","released")}),
});

export const gitRemoveWorktree: ExperimentalHostRpcHandlers<typeof hostContract>["gitRemoveWorktree"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  ...await removeLaneWorktree({basePath:input.basePath,worktreePath:input.worktreePath}),
});

export const gitSyncWorktree: ExperimentalHostRpcHandlers<typeof hostContract>["gitSyncWorktree"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  ...await syncWorktree({basePath:input.basePath,worktreePath:input.worktreePath,keepConflicts:input.keepConflicts}),
});

/** Free space for whoever decides before a spawn: a full disk (OVH, 2026-10-03) killed the BB host daemon. */
export const diskFree: ExperimentalHostRpcHandlers<typeof hostContract>["diskFree"] = async (input) => {
  const fs = await statfs(input.path);
  return { hostId:process.env.BB_HOST_ID??input.requestedHostId, path:input.path, freeBytes:Number(fs.bavail)*Number(fs.bsize), totalBytes:Number(fs.blocks)*Number(fs.bsize) };
};

/**
 * Writer worktrees live in ~/.lane-pilot/worktrees on the host. BB refuses to start a thread in a folder inside its
 * own storage that is not one of its environments (HTTP 409 «Workspace path is inside bb-managed storage»), which
 * is where the plugin's data dir is: every SelfyStudio writer on OVH failed to spawn that way on 2026-10-02.
 */
export const laneWorktreeRoot = () => join(homedir(), ".lane-pilot", "worktrees");

export const gitCreateWorktree: ExperimentalHostRpcHandlers<typeof hostContract>["gitCreateWorktree"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  ...await createWorktree({basePath:input.basePath,name:input.name,
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

export const docsAnchors: ExperimentalHostRpcHandlers<typeof hostContract>["docsAnchors"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId, ...await buildDocsAnchors({projectCwd:input.projectCwd,pages:input.pages,prefix:input.prefix,exclude:input.exclude,workspaces:input.workspaces}),
});

export const docsFlows: ExperimentalHostRpcHandlers<typeof hostContract>["docsFlows"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId, ...await buildDocsFlows({projectCwd:input.projectCwd,workspaces:input.workspaces,keep:input.keep}),
});

export const docsDepth: ExperimentalHostRpcHandlers<typeof hostContract>["docsDepth"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId, ...await readDocsDepth({projectCwd:input.projectCwd,pages:input.pages,core:input.core}),
});

export const docsVerifyCitations: ExperimentalHostRpcHandlers<typeof hostContract>["docsVerifyCitations"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId, ...await verifyDocsCitations({projectCwd:input.projectCwd,pages:input.pages,related:input.related}),
});

export const docsStalenessHandler: ExperimentalHostRpcHandlers<typeof hostContract>["docsStaleness"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  ...await docsStaleness({projectCwd:input.projectCwd,base:input.base,changed:input.changed,pages:input.pages}),
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
    size:bytes.byteLength, sha256:createHash("sha256").update(bytes).digest("hex"), content };
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
      pages.push({path:rel,modifiedAt:Math.trunc(info.mtimeMs),sha256:createHash("sha256").update(bytes).digest("hex"),content:bytes.toString("utf8")});
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
  const suppliedPreviewSha256=createHash("sha256").update(JSON.stringify(input.edits),"utf8").digest("hex");
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
      const currentHash=createHash("sha256").update(await readFile(fullPath)).digest("hex");
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
      const currentHash=currentInfo?createHash("sha256").update(await readFile(target.fullPath)).digest("hex"):null;
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
      const latestHash=latestInfo?createHash("sha256").update(await readFile(target.fullPath)).digest("hex"):null;
      if((latestInfo?.isSymbolicLink()??false)||latestHash!==target.expectedSha256){
        await unlink(tempPath).catch(()=>undefined);tempPath=undefined;
        writes.push({path:target.path,beforeSha256:latestHash,afterSha256:latestHash,status:"conflict",reason:"target changed before atomic replacement"});
        return {hostId:process.env.BB_HOST_ID??input.requestedHostId,previewSha256:input.previewSha256,status:writes.length===1?"conflict":"blocked",writes,reason:"onboarding compare-and-swap changed during apply"};
      }
      await rename(tempPath,target.fullPath);tempPath=undefined;
      const afterSha256=createHash("sha256").update(await readFile(target.fullPath)).digest("hex");
      if(afterSha256!==createHash("sha256").update(bytes).digest("hex")) throw new Error("onboarding atomic-write readback hash mismatch");
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

export const runCli: ExperimentalHostRpcHandlers<typeof hostContract>["runCli"] = async (input) => (
  runCliOnHost(input)
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
  const planSha256 = createHash("sha256").update(input.plan, "utf8").digest("hex");
  const sourceLength = Buffer.byteLength(input.plan, "utf8");
  const payload = { model:"jev-latest", state:{ task:input.plan }, questions:{ effort:PLAN_EFFORT_QUESTION } };
  const body = JSON.stringify(payload);
  const decodedPlan = (JSON.parse(body) as { state:{ task:string } }).state.task;
  const sentPlanSha256 = createHash("sha256").update(decodedPlan, "utf8").digest("hex");
  const sentLength = Buffer.byteLength(decodedPlan, "utf8");
  const transportProof = { planSha256, sentPlanSha256, sourceLength, sentLength };
  if (sentPlanSha256 !== planSha256 || sentLength !== sourceLength) {
    return { hostId, status:"error", effort:null, reason:"plan_serialization_mismatch", ...transportProof };
  }
  const apiKey = await jevApiKey();
  if (!apiKey) return { hostId, status:"disabled", effort:null, reason:"missing_typesafe_api_key",
    planSha256, sentPlanSha256:null, sourceLength, sentLength:null };
  try {
    const response = await fetch("https://api.typesafe.ai/v1/systemone", {
      method:"POST",
      headers:{ authorization:`Bearer ${apiKey}`, "content-type":"application/json" },
      body,
      signal:AbortSignal.timeout(2500),
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
  const apiKey = await jevApiKey();
  if (!apiKey) return { hostId, status:"disabled", answers:{}, reason:"missing_typesafe_api_key" };
  let state: unknown = input.state;
  try { state = JSON.parse(input.state); } catch { /* a plain text state is allowed */ }
  const questions = Object.fromEntries(Object.entries(input.questions).map(([name, question]) => [name, { type:"choice", instructions:question.instructions, criteria:question.criteria }]));
  try {
    const response = await fetch("https://api.typesafe.ai/v1/systemone", {
      method:"POST",
      headers:{ authorization:`Bearer ${apiKey}`, "content-type":"application/json" },
      body:JSON.stringify({ model:"jev-latest", state, questions }),
      signal:AbortSignal.timeout(4000),
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

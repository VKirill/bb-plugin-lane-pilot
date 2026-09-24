import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, open, readFile, readlink, readdir, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { homedir } from "node:os";
import type { ExperimentalHostRpcHandlers } from "@get-bb/plugin-sdk";
import { hostContract } from "./contracts";
import { inventoryCoexistence, runCoexistenceOperation } from "./coexistence";
import { runBrowserQaOnHost } from "./stages/browser-qa";
import { scanCritiqueCoverage } from "./stages/critique-coverage";
import { runSandboxedCommandOnHost } from "./verification/sandbox";
import { gitOwnershipChangedPaths, resolveGitOwnershipBase } from "./verification/git-ownership";
import { runCliOnHost, runCommandOnHost, writePmSettingsOnHost } from "./cli-run";
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

export const gitOwnershipChanges: ExperimentalHostRpcHandlers<typeof hostContract>["gitOwnershipChanges"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  ...await gitOwnershipChangedPaths({projectCwd:input.projectCwd,baseSha:input.baseSha,compareCommitted:input.compareCommitted}),
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

export const listDocsPages: ExperimentalHostRpcHandlers<typeof hostContract>["listDocsPages"] = async (input) => {
  const root = await lstat(input.projectCwd);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("docs project root must be a real directory");
  const pages:Array<{path:string;modifiedAt:number;sha256:string;content:string}> = [];
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
      if (bytes.byteLength > 40_000) throw new Error(`docs page exceeds 40000 bytes: ${rel}`);
      pages.push({path:rel,modifiedAt:Math.trunc(info.mtimeMs),sha256:createHash("sha256").update(bytes).digest("hex"),content:bytes.toString("utf8")});
      if (pages.length > 5000) throw new Error("docs inventory exceeds 5000 markdown files; reduce the source tree before running maintenance");
    }
  };
  for (const name of ["docs","apps"]) {
    const path=join(input.projectCwd,name);
    try { const info=await lstat(path); if(info.isDirectory()&&!info.isSymbolicLink()) await visit(path); }
    catch(cause) { if((cause as NodeJS.ErrnoException).code!=="ENOENT") throw cause; }
  }
  return {hostId:input.requestedHostId,pages};
};

export const applyOnboardingPages: ExperimentalHostRpcHandlers<typeof hostContract>["applyOnboardingPages"] = async (input) => {
  const suppliedPreviewSha256=createHash("sha256").update(JSON.stringify(input.edits),"utf8").digest("hex");
  if(suppliedPreviewSha256!==input.previewSha256) return {hostId:process.env.BB_HOST_ID??input.requestedHostId,previewSha256:input.previewSha256,status:"blocked",writes:[],reason:"onboarding preview hash did not match supplied edits"};
  const rootInfo=await lstat(input.projectCwd);
  if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink()) throw new Error("onboarding project root must be a real directory");
  const root=await realpath(input.projectCwd);
  const totalBytes=input.edits.reduce((sum,edit)=>sum+Buffer.byteLength(edit.content,"utf8"),0);
  if(totalBytes>32_000) throw new Error("onboarding preview exceeds 32000 total bytes");
  const targets:Array<{path:string;fullPath:string;expectedSha256:string|null;beforeMode:number|null}> = [];
  for(const edit of input.edits){
    const normalized=edit.path;
    const segments=normalized.split("/");
    if(normalized.includes("\\")||isAbsolute(normalized)||segments.some((part)=>!part||part==="."||part==="..")
      ||!((normalized.startsWith("docs/")||normalized.startsWith("apps/"))&&/\.md$/i.test(normalized))) {
      throw new Error(`onboarding path is outside Markdown docs scope: ${normalized}`);
    }
    let cursor=root;
    for(const segment of segments.slice(0,-1)){
      cursor=join(cursor,segment);
      const info=await lstat(cursor);
      if(info.isSymbolicLink()||!info.isDirectory()) throw new Error(`onboarding parent must be a real directory: ${normalized}`);
    }
    const fullPath=join(root,...segments);
    const parentReal=await realpath(dirname(fullPath));
    const parentRelative=relative(root,parentReal);
    if(parentRelative.startsWith("..")||isAbsolute(parentRelative)) throw new Error(`onboarding parent escaped the project: ${normalized}`);
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

export const runBrowserQa: ExperimentalHostRpcHandlers<typeof hostContract>["runBrowserQa"] = async (input) => (
  runBrowserQaOnHost(input)
);

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

async function jevApiKey(): Promise<string> {
  const fromEnv = (process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY || "").trim();
  if (fromEnv) return fromEnv;
  try {
    const text = await readFile(`${homedir()}/secrets/typesafe.env`, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const name = trimmed.slice(0, eq);
      if (name !== "TYPESAFE_API_KEY" && name !== "JEV_API_KEY") continue;
      const value = trimmed.slice(eq + 1).trim().replace(/^['\"]|['\"]$/g, "");
      if (value) return value;
    }
  } catch { /* report disabled below */ }
  return "";
}

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

export const inspectCritiqueCoverage: ExperimentalHostRpcHandlers<typeof hostContract>["inspectCritiqueCoverage"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  ...await scanCritiqueCoverage({workspacePath:input.workspacePath,plan:input.plan,
    tasks:input.tasks.map((task)=>({id:task.id,lane:task.lane,owns_paths:task.ownsPaths,has_verification:task.hasVerification,
      verification:task.verification.map((command)=>({command:command.command,timeout_sec:command.timeoutSec}))}))}),
});

export const writePmSettings: ExperimentalHostRpcHandlers<typeof hostContract>["writePmSettings"] = async (input) => (
  writePmSettingsOnHost(input)
);

export const snapshotDryRun: ExperimentalHostRpcHandlers<typeof hostContract>["snapshotDryRun"] = async (input) => ({
  hostId: process.env.BB_HOST_ID ?? input.requestedHostId,
  entries: await Promise.all(input.paths.map(async (path) => {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) return { path, kind:"symlink" as const, sha256:null, symlinkTarget:await readlink(path) };
      if (info.isFile()) return { path, kind:"file" as const, sha256:await hashFile(path), symlinkTarget:null };
      if (info.isDirectory()) return { path, kind:"directory" as const, sha256:null, symlinkTarget:null };
      return { path, kind:"other" as const, sha256:null, symlinkTarget:null };
    } catch {
      return { path, kind:"missing" as const, sha256:null, symlinkTarget:null };
    }
  })),
});

import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { ExperimentalHostRpcHandlers } from "@get-bb/plugin-sdk";
import { bestEffort, sha256Hex } from "@lane-pilot/kit";
import { hostContract } from "../../contracts";
import { renameRetry } from "../../platform";
import { casWriteWorkflowFile } from "../../storage";

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

/** The phase book (BOOK.md) and the phase's own files, only inside `.agents/phases/<phase-id>/` (src/rooms/phase). */
export const writePhaseBook: ExperimentalHostRpcHandlers<typeof hostContract>["writePhaseBook"] = async (input) =>
  casWriteMarkdown({ ...input, confirmed:true }, 2_000_000, (path) => (/^\.agents\/phases\/ph_[a-z0-9]{6,}\/[^/]+(\/[^/]+)*$/.test(path) || /^\.agents\/planning\/(STATE|ROADMAP)\.md$/.test(path)) && !path.includes(".."));

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
        await bestEffort(console.warn, `onboarding temp cleanup ${target.path}`, unlink(tempPath), undefined);tempPath=undefined;
        writes.push({path:target.path,beforeSha256:latestHash,afterSha256:latestHash,status:"conflict",reason:"target changed before atomic replacement"});
        return {hostId:process.env.BB_HOST_ID??input.requestedHostId,previewSha256:input.previewSha256,status:writes.length===1?"conflict":"blocked",writes,reason:"onboarding compare-and-swap changed during apply"};
      }
      await renameRetry(tempPath,target.fullPath);tempPath=undefined;
      const afterSha256=sha256Hex(await readFile(target.fullPath));
      if(afterSha256!==sha256Hex(bytes)) throw new Error("onboarding atomic-write readback hash mismatch");
      writes.push({path:target.path,beforeSha256:target.expectedSha256,afterSha256,status:"applied",reason:null});
    }catch(cause){
      if(tempPath) await bestEffort(console.warn, `onboarding temp cleanup ${target.path}`, unlink(tempPath), undefined);
      const reason=cause instanceof Error?cause.message:String(cause);
      writes.push({path:target.path,beforeSha256:target.expectedSha256,afterSha256:null,status:"blocked",reason});
      return {hostId:process.env.BB_HOST_ID??input.requestedHostId,previewSha256:input.previewSha256,status:"blocked",writes,reason};
    }
  }
  return {hostId:process.env.BB_HOST_ID??input.requestedHostId,previewSha256:input.previewSha256,status:"applied",writes,reason:null};
}

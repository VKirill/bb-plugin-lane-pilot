import { bestEffort, isNotFound, orMiss, BestEffortLog } from "@lane-pilot/kit";
import { taskFolderRel } from "../../verification";
import type { ServerCore } from "../../contracts/server";
import type { TaskFolderBrief } from "./writer-task";
import { resolve } from "node:path";

/** A projects.get probe: a lookup that cannot answer null — callers take their old path (hasOtherRootSource keeps BB's managed worktree). */
const projectOrNull = (bb: { sdk: { projects: { get(args: { projectId: string }): Promise<unknown> } } }, projectId: string, log?: BestEffortLog) =>
  bestEffort(log ?? ((message: string) => {}), "writer project probe", Promise.resolve().then(() => bb.sdk.projects.get({ projectId })), null) as Promise<{ sources?: Array<{ hostId?: string; path?: string }> } | null>;

/** True when the run works in the project's own checkout on that machine, which BB's managed worktree can fork. */
export async function isProjectRootCheckout(bb: { sdk: { projects: { get(args: { projectId: string }): Promise<unknown> } } }, projectId: string, hostId: string, path: string, log?: BestEffortLog): Promise<boolean> {
  const project = await projectOrNull(bb, projectId, log);
  return (project?.sources ?? []).some((source) => source.hostId === hostId && typeof source.path === "string" && resolve(source.path) === resolve(path));
}

export function worktreeCreateError(reason: string | null): string {
  return `attempt_worktree_failed:${reason ?? "unknown"}`;
}

/** The project has a root source on this host and the run folder is not it: BB's managed worktree would fork that root. */
export async function hasOtherRootSource(bb:ServerCore["bb"], projectId:string, hostId:string, path:string, log?: BestEffortLog):Promise<boolean> {
  const project = await projectOrNull(bb, projectId, log);
  const roots = (project?.sources ?? []).filter((source) => source.hostId === hostId && typeof source.path === "string");
  return roots.length > 0 && !roots.some((source) => resolve(source.path!) === resolve(path));
}

/** True when the attempt already works in the run folder, so there is no worktree to merge or remove. */
export function shouldMergeAttemptWorktree(workspacePath:string|null|undefined, basePath:string|null|undefined):boolean {
  return Boolean(workspacePath && basePath && resolve(workspacePath) !== resolve(basePath));
}

/** BB refused or lost the provider itself (not a budget, a network or a bad request): the attempt may go on the old path. */
export const providerRefusal = (cause:unknown) => /environment[ _-]?provider/i.test(cause instanceof Error ? cause.message : String(cause));

export function inPlaceEnvironment(hostId:string, workspacePath:string, environmentId:string|null):
  {type:"reuse";environmentId:string}|{type:"host";hostId:string;workspace:{type:"unmanaged";path:string}} {
  return environmentId
    ? { type:"reuse", environmentId }
    : { type:"host", hostId, workspace:{ type:"unmanaged", path:workspacePath } };
}

export async function listTaskFolder(bb:{sdk:{files:{read(args:{hostId:string;rootPath:string;path:string}):Promise<unknown>;listPaths(args:{hostId:string;path:string;includeFiles:boolean;includeDirectories:boolean;includeHidden:boolean;limit:number}):Promise<{paths?:Array<{kind?:string;name?:string;path?:string}>}>}}},
  hostId:string, workspacePath:string, taskId:string):Promise<TaskFolderBrief|null> {
  const rel = taskFolderRel(taskId);
  if (!rel) return null;
  const file = await orMiss(bb.sdk.files.read({ hostId, rootPath:workspacePath, path:resolve(workspacePath, rel, "PLAN.md") }), null, isNotFound);
  const content = file && typeof file === "object" ? (file as { content?:unknown }).content : null;
  if (typeof content !== "string") return null;
  const files = new Set<string>(["PLAN.md"]);
  const listed = await orMiss(bb.sdk.files.listPaths({
    hostId, path:resolve(workspacePath, rel), includeFiles:true, includeDirectories:false, includeHidden:true, limit:100,
  }), null, isNotFound);
  for (const entry of listed?.paths ?? []) {
    if (entry.kind !== "file") continue;
    const name = typeof entry.name === "string" && entry.name ? entry.name
      : typeof entry.path === "string" ? entry.path.replace(/^.*\//, "") : "";
    if (name && !name.includes("..") && !name.includes("/")) files.add(name);
  }
  return { path:`${rel}/`, files:[...files].sort() };
}

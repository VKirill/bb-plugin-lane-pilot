import { latestAttemptEnvironmentId, openDatabase } from "../../../storage";
import { GIT_PLUGIN_ID, gitCallRpc, gitFileSideReplySchema, gitFilesReplySchema, gitPatchKey, gitPatchesReplySchema } from "../../../platform/server";
import type { PluginCallRpc } from "../../../platform/server";

/**
 * The BB environment the task's attempt works in. BB refuses a thread at a path inside an environment's directory
 * (HTTP 409 «reuse that environment instead»), so a critic of a worktree attempt runs in that environment.
 */
export function attemptEnvironment(db:ReturnType<typeof openDatabase>, runId:string, taskId:string, path:string):{ type:"reuse"; environmentId:string } | null {
  const environmentId = latestAttemptEnvironmentId(db as never, runId, taskId, path);
  return environmentId ? { type:"reuse", environmentId } : null;
}

/**
 * The change of each produced file as BB's own unified diff (the Git plugin's `files` + keyed `patches`, uncommitted) in the
 * attempt's environment, else in the BB environment at the task folder. A path BB cut or could not diff is left out: the packet
 * then shows its file. On an old BB without `plugins.callRpc` the retired `environments.diffPatch` is the fallback.
 */
export async function candidatePatches(bb:{ sdk:{ environments:{ list:(args:{ hostId:string; path:string }) => Promise<Array<{ id:string }>>; diffPatch?:(args:{ environmentId:string; paths:string[]; target:{ type:"uncommitted" } }) => Promise<unknown> }; plugins?:{ callRpc?:PluginCallRpc } } },
  db:ReturnType<typeof openDatabase>, input:{ runId:string; taskId:string; hostId:string; cwd:string; paths:string[] }):Promise<Record<string,string>> {
  if (!input.paths.length) return {};
  try {
    const environmentId = attemptEnvironment(db, input.runId, input.taskId, input.cwd)?.environmentId
      ?? (await bb.sdk.environments.list({ hostId:input.hostId, path:input.cwd }))[0]?.id;
    if (!environmentId) return {};
    const wanted = new Set(input.paths);
    const callRpc = gitCallRpc(bb);
    if (callRpc) {
      const target = { type:"uncommitted" } as const;
      const listing = gitFilesReplySchema.parse(await callRpc({ pluginId:GIT_PLUGIN_ID, method:"files", input:{ environmentId, target, ignoreWhitespace:false }, outputSchema:gitFilesReplySchema }));
      if (listing.outcome !== "available") return {};
      const byPath = new Map(listing.initialPatches.map((row) => [row.path, row]));
      const revision = new Map(listing.files.map((row) => [row.path, row.revision]));
      const missing = input.paths.filter((path) => !byPath.has(path) && revision.has(path));
      for (let index = 0; index < missing.length; index += 50) {
        const keys = missing.slice(index, index + 50).map((path) => gitPatchKey(environmentId, target, false, path, revision.get(path)!));
        const reply = gitPatchesReplySchema.parse(await callRpc({ pluginId:GIT_PLUGIN_ID, method:"patches", input:{ keys }, outputSchema:gitPatchesReplySchema }));
        for (const entry of Object.values(reply)) if (entry.outcome === "available") byPath.set(entry.patch.path, entry.patch);
      }
      return Object.fromEntries([...byPath.values()].filter((row) => wanted.has(row.path) && !row.truncated && row.patch).map((row) => [row.path, row.patch]));
    }
    const result = await bb.sdk.environments.diffPatch?.({ environmentId, paths:input.paths, target:{ type:"uncommitted" } }) as { outcome?:string; patches?:Array<{ path:string; patch:string; truncated:boolean }> } | undefined;
    if (result?.outcome !== "available") return {};
    return Object.fromEntries((result.patches ?? []).filter((row) => wanted.has(row.path) && !row.truncated && row.patch).map((row) => [row.path, row.patch]));
  } catch {
    return {};
  }
}

/**
 * Changed files as git's HEAD has them, for an attempt that worked in the project folder itself (39 of 682 attempts in the week to
 * 2026-11-10; photoalive that day). There the base and the workspace are one folder: a file read from «the base» is the writer's own
 * text, so a test the attempt created «existed before the task» and a weakened test equalled itself. A string is HEAD's text, null says
 * the attempt created the file, and a path left out means git could not say (no git, an old BB, the change already committed, a
 * project_cwd below the repository root): the caller keeps its own reading.
 * ponytail: HEAD, not the folder as the attempt found it. Dirt left by an earlier attempt of the task is compared as this one's change.
 */
export async function headSides(bb:unknown, db:ReturnType<typeof openDatabase>,
  input:{ runId:string; taskId:string; hostId:string; cwd:string; paths:string[] }):Promise<Map<string,string|null>> {
  const sides = new Map<string,string|null>();
  const callRpc = gitCallRpc(bb);
  if (!callRpc || !input.paths.length) return sides;
  try {
    const list = (bb as { sdk?:{ environments?:{ list?:(args:{ hostId:string; path:string }) => Promise<Array<{ id:string }>> } } }).sdk?.environments?.list;
    const environmentId = attemptEnvironment(db, input.runId, input.taskId, input.cwd)?.environmentId
      ?? (await list?.({ hostId:input.hostId, path:input.cwd }))?.[0]?.id;
    if (!environmentId) return sides;
    const listing = gitFilesReplySchema.parse(await callRpc({ pluginId:GIT_PLUGIN_ID, method:"files", input:{ environmentId, target:{ type:"uncommitted" }, ignoreWhitespace:false }, outputSchema:gitFilesReplySchema }));
    if (listing.outcome !== "available") return sides;
    const kinds = new Map(listing.files.map((row) => [row.path, (row as { changeKind?:unknown }).changeKind]));
    for (const path of input.paths) {
      if (!kinds.has(path)) continue;
      if (kinds.get(path) === "added") { sides.set(path, null); continue; }
      try {
        const side = gitFileSideReplySchema.parse(await callRpc({ pluginId:GIT_PLUGIN_ID, method:"fileSide", input:{ environmentId, query:{ target:"uncommitted", path, side:"old" } }, outputSchema:gitFileSideReplySchema }));
        if (side.outcome === "available" && side.file.contentEncoding === "utf8") sides.set(path, side.file.content);
      } catch { /* this path stays unknown */ }
    }
  } catch { /* git could not say */ }
  return sides;
}

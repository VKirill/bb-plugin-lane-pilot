import { resolve } from "node:path";
import { isNotFound, orMiss, sha256Hex } from "@lane-pilot/kit";
import type { ServerCore } from "../../../contracts/server";
import type { FinishInput, Services } from "./finish-types";

/** Capture current produced files and their observed hashes for the critic. */
export async function captureCritiqueFiles(ctx:ServerCore, input:FinishInput, produced:string[], dirt:Awaited<ReturnType<Services["workspaceDirt"]>>) {
  const { bb } = ctx;
  const byPath = new Map((dirt.ok ? dirt.snapshots : []).map((row) => [row.path, row.sha256 || null]));
  const files:Array<{ path:string; content:string|null|undefined }> = [];
  for (const path of produced) {
    let content: string | null | undefined;
    try {
      const file = await orMiss(bb.sdk.files.read({
        hostId:input.config.hostId, rootPath:input.task.project_cwd, path:resolve(input.task.project_cwd, path),
      }), null, isNotFound);
      content = typeof file?.content === "string" ? file.content : null;
    } catch (cause) {
      // One unreadable produced file is a named hold, not a silent pass; the rest still count.
      // undefined is the read-outage outcome, distinct from null (absent).
      ctx.log(`writer ${input.taskId}: the produced file ${path} could not be read (${cause instanceof Error ? cause.message : String(cause)}); its evidence is left out`);
      content = undefined;
    }
    files.push({ path, content });
  }
  // A produced file the writer committed leaves no git-status dirt: a path absent from a successful snapshot
  // takes the sha256 of the bytes just read — the same bytes buildCandidateEvidence compares. A snapshot row
  // (hash or explicit null), a failed snapshot and an unreadable file all stay unknown.
  const contentByPath = new Map(files.map((row) => [row.path, row.content]));
  const hashes = Object.fromEntries(produced.map((path) => {
    if (byPath.has(path)) return [path, byPath.get(path) ?? null];
    if (!dirt.ok) return [path, null];
    const content = contentByPath.get(path);
    return [path, typeof content === "string" ? sha256Hex(content) : null];
  }));
  return { files, hashes };
}

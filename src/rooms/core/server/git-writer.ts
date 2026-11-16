import { createWriterDispatch, createWriterSpawn } from "../../writer/server";
import { createProjectGit, createProjectGitDispatch, overlappingLiveRuns, type FolderPool } from "../../project-git/server";

/** Compose one shared live-folder instance for bootstrap invalidation and writer admission. */
export function createGitWriter(
  ctx: Parameters<typeof createWriterSpawn>[0],
  services: Parameters<typeof createWriterSpawn>[1] & Parameters<typeof createWriterDispatch>[1] & { runWriterPool: FolderPool },
) {
  const writerSpawn = createWriterSpawn(ctx, services);
  const projectGit = createProjectGit({
    host: ctx.host,
    kv: ctx.bb.storage.kv,
    ownerAsk: ctx.ownerAsk,
    log: ctx.log,
    activeLiveRun: async ({ hostId, root }) => overlappingLiveRuns(ctx.db, hostId, root)[0] ?? null,
  });
  const rawWriterDispatch = createWriterDispatch(ctx, services);
  const guardedDispatch = createProjectGitDispatch({
    db: ctx.db,
    bb: ctx.bb,
    projectGit,
    runWriterPool: services.runWriterPool,
    invalidateLiveFolder: writerSpawn.invalidateLiveFolder,
    raw: rawWriterDispatch.dispatchWriter as never,
    isDisposed: ctx.isDisposed,
  });
  return { writerSpawn, writerDispatch: { ...rawWriterDispatch, dispatchWriter: guardedDispatch as never } };
}

import { join } from "node:path";
import { isNotFound, orMiss } from "@lane-pilot/kit";
import {
  archiveDefinition,
  definitionSha256,
  loadWorkflow,
  type ArchiveLogger,
  type DraftRow,
  type DraftStore,
  type Workflow,
} from "@lane-pilot/workflow-engine";
import type { ServerCore } from "../../../contracts/server";
import { nodeFileSource } from "../../../storage";
import { builtinWorkflow } from "../../builtin";

/** Creates a logger backed by `ctx.bb.log` with fallback to `ctx.log` for archive diagnostics. */
export function makeArchiveLogger(ctx: Pick<ServerCore, "bb" | "log">): ArchiveLogger {
  const bbLog = (ctx.bb as { log?: { debug?: (msg: string) => void; warn?: (msg: string) => void } } | undefined)?.log;
  return {
    debug: (message) => {
      if (bbLog?.debug) bbLog.debug(message);
      else ctx.log(message);
    },
    warn: (message) => {
      if (bbLog?.warn) bbLog.warn(message);
      else ctx.log(`WARN ${message}`);
    },
  };
}

/** Archives the previous published revision (draft snapshot, existing global file, and base built-in) before a CAS write. */
export async function archivePreviousRevision(
  ctx: Pick<ServerCore, "db" | "bb" | "log">,
  input: {
    draft: DraftRow;
    drafts: DraftStore;
    globalDir: string;
    resolve: (id: string, version?: number) => Workflow | null;
    log?: ArchiveLogger;
  },
): Promise<void> {
  const log = input.log ?? makeArchiveLogger(ctx);
  const { draft, drafts, globalDir, resolve } = input;
  const id = draft.workflowId;

  const prevSnap = drafts.latestPublishedSnapshot(draft.id);
  if (prevSnap) {
    const prevScope = draft.scope === "project" ? { level: "project" as const, projectId: draft.projectId } : { level: "global" as const };
    const prevLoaded = loadWorkflow({ ...prevSnap.definition, status: "published", version: prevSnap.publishedVersion, scope: prevScope }, { resolve });
    if (prevLoaded.ok) {
      archiveDefinition(
        ctx.db,
        { workflowId: id, version: prevSnap.publishedVersion, sha: definitionSha256(prevLoaded.workflow), json: JSON.stringify(prevLoaded.workflow), scope: draft.scope },
        { log, bestEffort: true },
      );
    }
  }

  if (draft.scope === "global") {
    const existingText = await orMiss(nodeFileSource.read(join(globalDir, `${id}.json`)), null, isNotFound).catch(() => null);
    if (existingText) {
      const existingLoaded = loadWorkflow(existingText, { resolve });
      if (existingLoaded.ok) {
        archiveDefinition(
          ctx.db,
          { workflowId: id, version: existingLoaded.workflow.version, sha: definitionSha256(existingLoaded.workflow), json: existingText, scope: "global" },
          { log, bestEffort: true },
        );
      }
    }
  }

  const baseBuiltin = builtinWorkflow(id);
  if (baseBuiltin) {
    archiveDefinition(
      ctx.db,
      { workflowId: id, version: baseBuiltin.version, sha: definitionSha256(baseBuiltin), json: JSON.stringify(baseBuiltin), scope: "builtin" },
      { log, bestEffort: true },
    );
  }
}

/** Archives the newly published revision after a successful CAS write. */
export function archivePublishedRevision(
  ctx: Pick<ServerCore, "db" | "bb" | "log">,
  input: { workflow: Workflow; json?: string; scope: string; log?: ArchiveLogger },
): void {
  const log = input.log ?? makeArchiveLogger(ctx);
  archiveDefinition(
    ctx.db,
    {
      workflowId: input.workflow.id,
      version: input.workflow.version,
      sha: definitionSha256(input.workflow),
      json: input.json ?? JSON.stringify(input.workflow),
      scope: input.scope,
    },
    { log, bestEffort: true },
  );
}

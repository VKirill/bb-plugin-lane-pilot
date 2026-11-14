import { isNotFound, orMiss } from "@lane-pilot/kit";
import type { StepContext } from "@lane-pilot/workflow-engine";
import { openRunHome, recordRunFileRow, writeRunManifest, type RunFileKind, type TaskFileIo } from "../../storage";
import { writeCasCheckoutFile } from "../../storage";
import { noteEngineWrite } from "../../verification/server";
import type { ChainRuntime, ServerCore } from "../../contracts/server";

/**
 * The run folder of a workflow-graph run (docs/task-folder.md, «The run folder»): the nodes that write files (`fs.write`, `sp.run_script`) and the
 * engine's step-input spill tell it here, and `.agents/runs/<run-id>/manifest.json` in the checkout lists them. The manifest is a rendering of the
 * database rows: a failure to write it is logged and never stops the node that already wrote its own file.
 */

type Checkout = { hostId: string; path: string };

/** Reads and writes absolute paths in one checkout. A write REPLACES (read, then a hash-checked write: the manifest is rewritten at every record). */
export function checkoutFileIo(ctx: Pick<ServerCore, "bb">, checkout: Checkout): TaskFileIo {
  const root = checkout.path.replace(/\/+$/, "");
  return {
    read: async (absPath) => {
      const file = await orMiss(Promise.resolve().then(() => ctx.bb.sdk.files.read({ hostId: checkout.hostId, rootPath: root, path: absPath })), null, isNotFound);
      const content = file && typeof file === "object" ? (file as { content?: unknown }).content : null;
      return typeof content === "string" ? content : null;
    },
    write: async (absPath, content) => {
      const rel = absPath.startsWith(`${root}/`) ? absPath.slice(root.length + 1) : absPath;
      noteEngineWrite(checkout.path, rel);
      const written = await writeCasCheckoutFile(ctx.bb.sdk.files as never, { hostId: checkout.hostId, rootPath: root, relPath: rel, content });
      if (!written.ok) throw new Error(`run manifest write rejected for "${rel}" (${written.outcome})`);
    },
  };
}

/**
 * Records the files the current step wrote into its run's manifest, and renders the manifest once. `repoPath` is relative to the checkout (or to the
 * planning home when `root` says so). Never throws: the files are already written, and the rows are what the next reader asks.
 */
export async function noteRunFiles(ctx: Pick<ServerCore, "bb" | "db" | "log">, rt: ChainRuntime, c: StepContext<ChainRuntime>, checkout: Checkout, files: Array<{
  repoPath: string; content: string; kind: RunFileKind; root?: "checkout" | "planning-home"; readers?: readonly string[];
}>): Promise<void> {
  if (!files.length) return;
  try {
    openRunHome(ctx.db, { runId: c.runId, projectId: rt.projectId ?? "", workflowId: c.workflow.id, basePath: checkout.path, hostId: checkout.hostId });
    for (const file of files) {
      const row = recordRunFileRow(ctx.db, {
        runId: c.runId, repoPath: file.repoPath, kind: file.kind, nodeId: c.nodeId, content: file.content,
        producer: { node: c.nodeId, graph: c.workflow.id, run_id: c.runId, wf_step_key: c.stepKey }, ...(file.root ? { root: file.root } : {}), ...(file.readers ? { readers: file.readers } : {}),
      });
      if (row.replaces) ctx.log(`${c.workflow.id}/${c.nodeId} replaced ${file.repoPath} that run ${row.replaces.split(":")[0]} wrote (run ${c.runId} keeps the record)`);
    }
    await writeRunManifest(ctx.db, checkoutFileIo(ctx, checkout), c.runId);
  } catch (cause) {
    ctx.log(`run manifest of ${c.runId}: ${files.length} file(s) not recorded (${cause instanceof Error ? cause.message : String(cause)})`);
  }
}

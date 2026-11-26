import { createHash } from "node:crypto";
import { LP_EVENTS } from "@lane-pilot/contracts";
import { onMemoryRecordCommitted, type MemoryRecordCommittedEvent } from "@lane-pilot/memory-core";
import { START, insertInboxEvent, parseWorkflow, type Workflow, type WorkflowEngine } from "@lane-pilot/workflow-engine";
import { type ServerCore } from "../../../contracts/server";
import { envCatalogKey } from "../repositories/env-catalog-key";
import { EMBED_KEY_NAME, googleEmbedder, hasStaleVectors, runEmbedAndDedupe, setEmbedder, type Embedder } from "../services/embeddings";
import { mountMemoryJudge } from "../services/memory-judge";

export const MEMORY_EMBED_WORKFLOW_ID = "lp.memory-embed";
export const MEMORY_EMBED_ACTION = "lp.memory_embed_dedupe";

export type MountMemoryEmbeddingsServices = {
  workflowEngine?: WorkflowEngine;
  workflowTriggers?: {
    emitEvent: (
      name: string,
      payload?: Record<string, unknown>,
      options?: { id?: string; key?: string; projectId?: string },
    ) => Promise<{
      eventId: string;
      key: string;
      duplicate: boolean;
      woken: number;
      started: Array<{ workflowId: string; runId: string; created: boolean }>;
      failed: Array<{ workflowId: string; reason: string; message: string }>;
    }>;
  };
};

export type MountMemoryEmbeddingsOptions = {
  embedder?: Embedder;
  backfillOnReady?: boolean;
};

export function memoryEmbedWorkflow(): Workflow {
  return parseWorkflow({
    id: MEMORY_EMBED_WORKFLOW_ID,
    name: { en: "Memory embed and dedupe", ru: "Эмбеддинг и дедупликация памяти" },
    description: {
      en: "Embeds pending memory records and merges near-duplicate notes after a record commit or startup backfill.",
      ru: "Строит векторы новых записей памяти и объединяет близкие дубликаты после записи или при старте.",
    },
    category: "service",
    status: "published",
    internal: true,
    triggers: [{ type: "event", event: LP_EVENTS.MEMORY_RECORD_COMMITTED }],
    outputs: [{ name: "stored", type: "number" }, { name: "merged", type: "number" }],
    budget: { max_minutes: 10, max_usd: 0.01 },
    nodes: [
      {
        id: "embed_dedupe",
        type: "action",
        action: MEMORY_EMBED_ACTION,
        out: [{ name: "stored", type: "number" }, { name: "merged", type: "number" }],
      },
      {
        id: "done",
        type: "action",
        action: "emit",
        map: { stored: "embed_dedupe.stored", merged: "embed_dedupe.merged" },
      },
    ],
    edges: [
      { from: START, to: "embed_dedupe" },
      { from: "embed_dedupe", to: "done" },
    ],
  });
}

function commitEventId(evt: MemoryRecordCommittedEvent): string {
  const digest = createHash("sha256")
    .update(`${evt.projectId}\0${evt.personalBot}\0${evt.sourceSha256}\0${evt.insertedIds.join(",")}`)
    .digest("hex")
    .slice(0, 16);
  return `${LP_EVENTS.MEMORY_RECORD_COMMITTED}:${evt.projectId}:${digest}`;
}

export function mountMemoryEmbeddings(
  ctx: ServerCore,
  services?: MountMemoryEmbeddingsServices,
  options?: MountMemoryEmbeddingsOptions,
): { backfill: () => Promise<{ started: boolean; runId?: string; stored?: number; merged?: number }>; dispose: () => void } {
  const embedder = options?.embedder ?? googleEmbedder(envCatalogKey(ctx.bb, EMBED_KEY_NAME));
  setEmbedder(embedder);
  mountMemoryJudge(ctx);

  const engine = services?.workflowEngine;
  if (engine) {
    engine.register(MEMORY_EMBED_ACTION, {
      reentrant: true,
      run: async (c) => {
        try {
          return { output: await runEmbedAndDedupe(ctx, embedder) };
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          ctx.bb.log.error(`memory.embed-dedupe failed run=${c.runId}: ${message}`);
          throw cause;
        }
      },
    });
  }

  const handleCommit = async (evt: MemoryRecordCommittedEvent): Promise<void> => {
    if (ctx.isDisposed()) return;
    const eventId = commitEventId(evt);
    const payload = {
      eventId,
      projectId: evt.projectId,
      personalBot: evt.personalBot,
      sourceSha256: evt.sourceSha256,
      insertedIds: [...evt.insertedIds],
      origin: evt.origin,
    };

    if (services?.workflowTriggers) {
      const res = await services.workflowTriggers.emitEvent(LP_EVENTS.MEMORY_RECORD_COMMITTED, payload, {
        id: eventId,
        key: evt.projectId,
        projectId: evt.projectId,
      });
      if (res.duplicate) return;
      if (engine && !res.started.some((item) => item.workflowId === MEMORY_EMBED_WORKFLOW_ID)) {
        const started = engine.start({
          workflow: memoryEmbedWorkflow(),
          inputs: payload,
          key: `memory-embed:${eventId}`,
          link: { projectId: evt.projectId },
        });
        ctx.bb.log.info(`wf.event started job=memory-embed by=event run=${started.runId} project=${evt.projectId}`);
      }
      return;
    }

    if (engine) {
      let inserted = true;
      try {
        inserted = insertInboxEvent(ctx.db, {
          id: eventId,
          name: LP_EVENTS.MEMORY_RECORD_COMMITTED,
          key: evt.projectId,
          payload,
          createdAt: evt.now,
        });
      } catch {
        // Minimal test DBs without lane_pilot_wf_inbox still run the graph.
      }
      if (!inserted) {
        ctx.bb.log.warn(`wf.event duplicate event id skipped name=${LP_EVENTS.MEMORY_RECORD_COMMITTED} id=${eventId}`);
        return;
      }
      const started = engine.start({
        workflow: memoryEmbedWorkflow(),
        inputs: payload,
        key: `memory-embed:${eventId}`,
        link: { projectId: evt.projectId },
      });
      ctx.bb.log.info(`wf.event started job=memory-embed by=event run=${started.runId} project=${evt.projectId}`);
      return;
    }

    await runEmbedAndDedupe(ctx, embedder);
  };

  const unsubscribe = onMemoryRecordCommitted(ctx.db, (evt) => {
    void handleCommit(evt).catch((cause) => {
      ctx.bb.log.warn(`memory.embed-commit skipped: ${cause instanceof Error ? cause.message : String(cause)}`);
    });
  });

  const backfill = async (): Promise<{ started: boolean; runId?: string; stored?: number; merged?: number }> => {
    if (ctx.isDisposed() || !hasStaleVectors(ctx.db)) return { started: false };
    if (engine) {
      const started = engine.start({
        workflow: memoryEmbedWorkflow(),
        inputs: { reason: "startup-backfill" },
        key: `memory-embed-backfill:${engine.instanceId}`,
      });
      ctx.bb.log.info(`wf.event started job=memory-embed-backfill by=startup run=${started.runId}`);
      await started.done;
      return { started: true, runId: started.runId };
    }
    const out = await runEmbedAndDedupe(ctx, embedder);
    return { started: true, ...out };
  };

  if (options?.backfillOnReady !== false) {
    queueMicrotask(() => {
      void backfill().catch((cause) => {
        ctx.bb.log.warn(`memory.embed-backfill skipped: ${cause instanceof Error ? cause.message : String(cause)}`);
      });
    });
  }

  return { backfill, dispose: unsubscribe };
}

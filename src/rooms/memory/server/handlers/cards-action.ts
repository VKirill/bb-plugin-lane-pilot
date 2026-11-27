import type { StepContext, WorkflowEngine } from "@lane-pilot/workflow-engine";
import type { ServerCore } from "../../../contracts/server";
import { loadCards } from "../services/cards";

export const CARDS_LOAD_ACTION = "lp.cards_load";

type RawRef = { kind?: unknown; key?: unknown };

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function resolveProjectId(engine: WorkflowEngine, c: StepContext, params: Record<string, unknown>): string | null {
  if ("projectId" in params && params.projectId === null) return null;
  const fromParam = nonEmptyString(params.projectId);
  if (fromParam) return fromParam;
  const fromWith = nonEmptyString(c.input.with?.projectId);
  if (fromWith) return fromWith;
  const fromRuntime = nonEmptyString((c.runtime as { projectId?: unknown } | undefined)?.projectId);
  if (fromRuntime) return fromRuntime;
  const fromInputs = nonEmptyString(c.inputs?.projectId);
  if (fromInputs) return fromInputs;
  return nonEmptyString(engine.journal.getRun(c.runId)?.project_id);
}

function resolveRefs(c: StepContext, params: Record<string, unknown>): Array<{ kind: string; key: string }> {
  const raw = Array.isArray(params.refs) ? params.refs : Array.isArray(c.input.with?.refs) ? c.input.with.refs : [];
  return raw
    .filter((item): item is RawRef => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .map((item) => ({
      kind: typeof item.kind === "string" ? item.kind : "",
      key: typeof item.key === "string" ? item.key : "",
    }));
}

/** Registers the `lp.cards_load` read-only workflow action on the shared workflow engine. */
export function registerCardActions(engine: WorkflowEngine, ctx: Pick<ServerCore, "bb" | "db" | "log">): void {
  engine.register(CARDS_LOAD_ACTION, {
    reentrant: true,
    run: async (c) => {
      const node = c.node as { params?: Record<string, unknown> };
      const params = c.template(node.params ?? {}) as Record<string, unknown>;
      const projectId = resolveProjectId(engine, c, params);
      const refs = resolveRefs(c, params);
      const result = loadCards(ctx, { projectId, refs, now: engine.now() });
      return { output: result as unknown as Record<string, unknown> };
    },
  });
}

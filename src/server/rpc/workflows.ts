import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../contracts";
import type { ServerCore } from "../core";
import type { Services } from "../services";
import { createWorkflowLibrary } from "../workflow-library";
import { createWorkflowArchitect } from "../workflow-architect";

/** The Workflows screens' reads: the library, one workflow with its graph, one run as a live view; and the start of an edit (a draft of a library workflow). */
export function workflowsRpc(ctx: ServerCore, services: Services) {
  const library = createWorkflowLibrary(ctx, services);
  const architect = createWorkflowArchitect(ctx, services);
  return {
    workflow_list: ({ projectId }) => library.list({ projectId }),
    workflow_get: ({ id, projectId }) => library.get({ id, projectId }),
    workflow_run_snapshot: ({ runId }) => library.runSnapshot({ runId }),
    workflow_draft_create: async ({ projectId, workflowId, mode, scope }) => {
      const found = await library.source({ id: workflowId, projectId });
      if (!found) return { draftId: null, workflowId: null, reused: false, reason: "not_found" };
      const definition = JSON.parse(JSON.stringify(found.workflow)) as Record<string, unknown>;
      if (mode === "edit") {
        // A built-in workflow is read-only; the way to change it is a copy.
        if (found.origin === "builtin") return { draftId: null, workflowId, reused: false, reason: "builtin_read_only" };
        const level = found.origin === "project" ? "project" : "global";
        const existing = architect.drafts.list(projectId).find((draft) => draft.workflowId === workflowId && draft.scope === level);
        if (existing) return { draftId: existing.id, workflowId, reused: true };
        const draft = architect.createFrom({ projectId, scope: level, workflowId, definition, name: found.workflow.name, description: found.workflow.description,
          ...(found.fileSha256 ? { base: { path: found.path, sha256: found.fileSha256, version: found.workflow.version } } : {}) });
        return { draftId: draft.id, workflowId, reused: false };
      }
      const taken = new Set([...found.ids, ...architect.drafts.list(projectId).map((draft) => draft.workflowId)]);
      const stem = workflowId.slice(0, 40);
      let copyId = `${stem}-copy`;
      for (let number = 2; taken.has(copyId); number += 1) copyId = `${stem}-copy-${number}`;
      const name = { en: `${found.workflow.name.en} (copy)`.slice(0, 2000), ru: `${found.workflow.name.ru} (копия)`.slice(0, 2000) };
      const draft = architect.createFrom({ projectId, scope: scope ?? "global", workflowId: copyId, definition: { ...definition, name, version: 1 }, name, description: found.workflow.description });
      return { draftId: draft.id, workflowId: copyId, reused: false };
    },
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "workflow_list" | "workflow_get" | "workflow_run_snapshot" | "workflow_draft_create">;
}

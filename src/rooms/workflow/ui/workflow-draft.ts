import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import type { rpcContract, workflowDraftCheckSchema, workflowDraftSummarySchema } from "../../../contracts";
import { useLpRealtime } from "../../../ui/use-lp-realtime";

/**
 * CONTRACT for the Workflows tab (W5) and the editor (W6).
 *
 * A draft is the same value as a workflow file in the authoring spelling: `definition` goes through
 * `parseWorkflowObject` (src/workflow/schema.ts) exactly as a file does, so a graph component that draws a workflow
 * draws a draft with no other input. Differences to expect while the architect is building:
 *  - it is often invalid (`check.valid === false`, `check.problems` carry `node` and `edge` indexes to mark on the graph);
 *    draw the nodes and edges that parse and flag the rest instead of showing an error page;
 *  - `nodes` may be empty and `edges` may point at `start`/`end` or at a node that is not there yet;
 *  - `draft.version` rises with every change; a graph showing a lower one is behind.
 * The server publishes `{kind: "workflow-draft", draftId, threadId}` on `lp:<projectId>` after each change; this hook
 * re-reads on it (and on a reconnect), and falls back to a slow poll.
 *
 * `<DraftGraph definition problems />` is W5's graph component fed from `useWorkflowDraft`; nothing here draws.
 */
export type WorkflowDraftView = {
  draft: z.infer<typeof workflowDraftSummarySchema> | null;
  definition: Record<string, unknown> | null;
  check: z.infer<typeof workflowDraftCheckSchema> | null;
  /** The last test run of the current or an older version (`version` tells which). */
  tests: unknown;
  loading: boolean;
  error: string | null;
  reload: () => void;
};

export function useWorkflowDraft(projectId: string | null, draftId: string | null): WorkflowDraftView {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<Omit<WorkflowDraftView, "reload">>({ draft: null, definition: null, check: null, tests: null, loading: Boolean(draftId), error: null });
  const latest = useRef(draftId);
  latest.current = draftId;

  const read = useCallback(async () => {
    if (!draftId) { setState({ draft: null, definition: null, check: null, tests: null, loading: false, error: null }); return; }
    try {
      const result = await rpc.call("workflow_draft_get", { draftId, history: false });
      if (latest.current === draftId) setState({ draft: result.draft, definition: result.definition, check: result.check, tests: result.tests, loading: false, error: null });
    } catch (cause) {
      if (latest.current === draftId) setState((previous) => ({ ...previous, loading: false, error: cause instanceof Error ? cause.message : String(cause) }));
    }
  }, [rpc, draftId]);

  const readNow = useRef(read);
  readNow.current = read;
  const pollMs = useLpRealtime(projectId, ["workflow-draft"], (signal) => { if (!signal?.draftId || signal.draftId === latest.current) void readNow.current(); });
  useEffect(() => { void read(); }, [read]);
  useEffect(() => {
    if (!draftId) return;
    const timer = setInterval(() => { void readNow.current(); }, pollMs);
    return () => clearInterval(timer);
  }, [draftId, pollMs]);

  return { ...state, reload: () => { void read(); } };
}

import { useCallback, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../contracts";
import type { ViewNode, WorkflowView } from "../workflow/view";
import type { RunSnapshot } from "./workflow-run";

/**
 * Going into a subworkflow: «Open» on a subworkflow card makes the canvas show the workflow it calls (in a run, the child run behind the card,
 * with its statuses), with a trail of where you came from. The trail's first entry is the page's own graph and is kept by the page; every entry
 * after it is one subworkflow deeper. Going back to an entry drops all after it.
 */
type Call = (method: string, input: unknown) => Promise<unknown>;

export type DrillStep = {
  /** The canvas key of the card that was opened (for a run, to find its child run in the parent's snapshot). */
  key: string;
  /** The called workflow, its name for the breadcrumb, its graph and, in a run, the child run's snapshot. */
  workflowId: string; label: string; graph: WorkflowView; snapshot: RunSnapshot | null;
};

/** `nameOf(locale)` is given by the caller, since the page knows the locale. */
export function useDrill(options: { projectId: string | null; parentSnapshot: RunSnapshot | null }) {
  const rpc = useRpc<typeof rpcContract>() as unknown as { call: Call };
  const [trail, setTrail] = useState<readonly DrillStep[]>([]);
  const [opening, setOpening] = useState<string | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const seq = useRef(0);
  const scope = options.projectId ?? undefined;

  const open = useCallback(async (key: string, node: ViewNode, locale: "en" | "ru") => {
    const calls = node.calls;
    if (!calls) return;
    const mine = ++seq.current;
    setOpening(calls.id); setMissing(null);
    try {
      // The snapshot the card belongs to: the page's own run at the top, the child run of the step we are in below it.
      const here = trail.length ? trail[trail.length - 1]!.snapshot : options.parentSnapshot;
      const stepKeys = new Set((here?.steps ?? []).filter((step) => step.nodeId === node.id).map((step) => step.key));
      const child = [...(here?.children ?? [])].reverse().find((row) => stepKeys.has(row.stepKey));
      const snapshot = child ? ((await rpc.call("workflow_run_snapshot", { runId: child.runId })) as { snapshot: RunSnapshot | null }).snapshot : null;
      const definition = ((await rpc.call("workflow_get", { id: calls.id, ...(scope ? { projectId: scope } : {}) })) as { workflow: { name: { en: string; ru: string }; graph: WorkflowView } | null }).workflow;
      if (mine !== seq.current) return;
      const graph = snapshot ? snapshot.graph : definition?.graph;
      if (!graph) { setMissing(calls.id); return; }
      setTrail((current) => [...current, { key, workflowId: calls.id, label: definition?.name[locale] ?? calls.id, graph, snapshot }]);
    } catch { if (mine === seq.current) setMissing(calls.id); } finally { if (mine === seq.current) setOpening(null); }
  }, [rpc, scope, trail, options.parentSnapshot]);

  /** Back to the entry `index` of the breadcrumb (0 is the page's own graph). */
  const goTo = useCallback((index: number) => { seq.current += 1; setOpening(null); setTrail((current) => current.slice(0, index)); }, []);
  const reset = useCallback(() => { seq.current += 1; setOpening(null); setMissing(null); setTrail([]); }, []);
  /** A run moved on: the child runs behind the trail are read again. */
  const refresh = useCallback(async () => {
    const next: DrillStep[] = [];
    for (const step of trail) {
      if (!step.snapshot) { next.push(step); continue; }
      const fresh = ((await rpc.call("workflow_run_snapshot", { runId: step.snapshot.run.id }).catch(() => ({ snapshot: null }))) as { snapshot: RunSnapshot | null }).snapshot;
      next.push(fresh ? { ...step, graph: fresh.graph, snapshot: fresh } : step);
    }
    setTrail(next);
  }, [rpc, trail]);

  return { trail, opening, missing, open, goTo, reset, refresh };
}

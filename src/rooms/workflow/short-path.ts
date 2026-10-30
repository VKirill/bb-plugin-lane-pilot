import issueQuick from "../../../workflows/issue-quick.json";
import issueQuickLegacy from "../../../workflows/issue-quick-legacy.json";

/** Off keeps the previous issue-quick graph (triage, plan, build). Anything else, including a missing row, is the short path. */
export const ISSUE_QUICK_SHORT_PATH = "issue_quick.short_path";

export function issueQuickShortPath(settings: Record<string, unknown> | null | undefined): boolean {
  const value = settings?.[ISSUE_QUICK_SHORT_PATH];
  return !(value === false || value === 0 || value === "off" || value === "false");
}

export function issueQuickWorkflowId(settings: Record<string, unknown> | null | undefined): "issue-quick" | "issue-quick-legacy" {
  return issueQuickShortPath(settings) ? "issue-quick" : "issue-quick-legacy";
}

const WRITER = new Set(["write", "write-medium", "build"]);

/** Agent and subworkflow steps on the happy path before the writer. The short path is the one plan call; the old path is triage plus the plan graph. */
export function modelCallsBeforeWriter(nodes: readonly { id: string; type: string }[], path: readonly string[]): number {
  const type = new Map(nodes.map((node) => [node.id, node.type]));
  const cut = path.findIndex((id) => WRITER.has(id) || type.get(id) === "lp-task");
  const before = cut < 0 ? path : path.slice(0, cut);
  return before.filter((id) => type.get(id) === "agent" || type.get(id) === "subworkflow").length;
}

type GraphFile = { nodes: { id: string; type: string }[]; test?: { sim?: { expect_path?: string[] } } };

/** Model calls before the writer for the graph this setting starts. */
export function issueQuickModelCalls(settings: Record<string, unknown> | null | undefined): number {
  const graph = (issueQuickShortPath(settings) ? issueQuick : issueQuickLegacy) as GraphFile;
  return modelCallsBeforeWriter(graph.nodes, graph.test?.sim?.expect_path ?? []);
}

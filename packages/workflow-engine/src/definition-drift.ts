import type { HubDefinitionRow } from "./definition-archive";
import { definitionSha256 } from "./store";
import { loadWorkflow } from "./validate";

export const GRAPHS_LAST_EXPORT_AT_KEY = "graphs.last_export_at";

export type GraphDriftEntry = {
  workflowId: string;
  version: number;
  hubSha256: string;
  fileSha256: string | null;
  status: "missing" | "modified";
  scope: string;
  archivedAt: number;
};

/**
 * Compares the newest non-built-in hub definitions against `workflows/<id>.json` files as loaded.
 * Any missing file or SHA mismatch is reported as drift for git export and the weekly desk.
 */
export function findHubDefinitionDrift(
  hubRows: readonly HubDefinitionRow[],
  readWorkflowFile: (workflowId: string) => string | null,
): GraphDriftEntry[] {
  const drifted: GraphDriftEntry[] = [];
  for (const row of hubRows) {
    const fileText = readWorkflowFile(row.workflowId);
    if (fileText === null) {
      drifted.push({
        workflowId: row.workflowId,
        version: row.version,
        hubSha256: row.sha256,
        fileSha256: null,
        status: "missing",
        scope: row.scope,
        archivedAt: row.archivedAt,
      });
      continue;
    }
    const loaded = loadWorkflow(fileText);
    const fileSha256 = loaded.ok ? definitionSha256(loaded.workflow) : null;
    if (fileSha256 !== row.sha256) {
      drifted.push({
        workflowId: row.workflowId,
        version: row.version,
        hubSha256: row.sha256,
        fileSha256,
        status: "modified",
        scope: row.scope,
        archivedAt: row.archivedAt,
      });
    }
  }
  return drifted;
}

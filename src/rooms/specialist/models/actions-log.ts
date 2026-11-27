/**
 * RPC methods an actions-log entry may name as its undo: the server offers only these and the UI calls only these.
 * Each must be a registered RPC (there is no `revert` RPC: task reverts stay CLI-only).
 */
export const UNDO_METHODS = ["schedule_pause", "workflow_draft_rollback"] as const;

export type UndoMethod = (typeof UNDO_METHODS)[number];

const UNDO_METHOD_SET: ReadonlySet<string> = new Set(UNDO_METHODS);

/** Returns true only for methods in `UNDO_METHODS`. */
export function isAllowedUndoMethod(method: string | null | undefined): method is UndoMethod {
  return typeof method === "string" && UNDO_METHOD_SET.has(method);
}

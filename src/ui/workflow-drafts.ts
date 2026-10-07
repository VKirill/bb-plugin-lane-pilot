/**
 * The draft side of the Workflows tab talks to RPCs the workflow architect's server side provides:
 *   workflow_draft_list {projectId?}      -> { drafts: [{ draftId, name?, workflowId?, version?, updatedAt?, threadId? }] }
 *   workflow_draft_get {draftId}          -> { draftId?, version, workflow, threadId? }   (workflow in the workflow schema)
 *   workflow_architect_start {projectId}  -> { threadId }
 * They are called by name and read leniently: a build without them lists no drafts and the button reports the error, and a
 * field the server adds or omits does not break the screen.
 */
const call = (rpc: unknown, method: string, input: unknown): Promise<unknown> => (rpc as { call: (method: string, input: unknown) => Promise<unknown> }).call(method, input);

export type DraftRow = { draftId: string; name: { en: string; ru: string } | null; workflowId: string | null; version: number | null; updatedAt: number | null; threadId: string | null };
export type DraftDoc = { draftId: string; version: number | null; workflow: unknown; threadId: string | null; updatedAt: number | null };

const isRaw = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown) => (typeof value === "string" && value ? value : null);
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const name = (value: unknown): DraftRow["name"] => {
  if (str(value)) return { en: String(value), ru: String(value) };
  if (isRaw(value)) { const en = str(value.en), ru = str(value.ru); if (en || ru) return { en: en ?? ru!, ru: ru ?? en! }; }
  return null;
};

export async function listDrafts(rpc: unknown, projectId: string | null): Promise<DraftRow[]> {
  try {
    const result = await call(rpc, "workflow_draft_list", projectId ? { projectId } : {});
    const rows = isRaw(result) && Array.isArray(result.drafts) ? result.drafts : Array.isArray(result) ? result : [];
    return rows.flatMap((row) => {
      if (!isRaw(row)) return [];
      const draftId = str(row.draftId) ?? str(row.id);
      if (!draftId) return [];
      const workflow = isRaw(row.workflow) ? row.workflow : null;
      return [{ draftId, name: name(row.name) ?? name(workflow?.name), workflowId: str(row.workflowId) ?? str(workflow?.id), version: num(row.version),
        updatedAt: num(row.updatedAt) ?? num(row.updated_at), threadId: str(row.threadId) }];
    });
  } catch { return []; }
}

/** `null` when the draft does not exist (or the RPC is not there). */
export async function getDraft(rpc: unknown, draftId: string): Promise<DraftDoc | null> {
  try {
    const result = await call(rpc, "workflow_draft_get", { draftId });
    const body = isRaw(result) && isRaw(result.draft) ? result.draft : result;
    if (!isRaw(body)) return null;
    const workflow = body.workflow ?? (Array.isArray(body.nodes) ? body : null);
    if (!workflow) return null;
    return { draftId: str(body.draftId) ?? draftId, version: num(body.version) ?? (isRaw(result) ? num(result.version) : null), workflow, threadId: str(body.threadId), updatedAt: num(body.updatedAt) };
  } catch { return null; }
}

export async function startArchitect(rpc: unknown, projectId: string): Promise<string> {
  const result = await call(rpc, "workflow_architect_start", { projectId });
  const threadId = isRaw(result) ? str(result.threadId) : null;
  if (!threadId) throw new Error("no thread");
  return threadId;
}

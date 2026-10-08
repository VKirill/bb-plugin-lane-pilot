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
export type DraftProblem = { level: "error" | "warning"; code: string; message: string; node?: string; edge?: number };
export type DraftCheck = { valid: boolean; errors: number; warnings: number; nodes: number; edges: number; problems: DraftProblem[] };
export type DraftCaseResult = { caseId: string; green: boolean; status: string; path: string[]; failures: string[]; failedNode: string | null; notChecked: string[]; stubbed: Array<{ node: string; type: string; executor: string }> };
export type DraftTests = { version: number; at: number; green: boolean; results: DraftCaseResult[] };
export type DraftDoc = {
  draftId: string; version: number | null; workflow: unknown; threadId: string | null; updatedAt: number | null;
  /** The validator's verdict, the last test run and the version log: present when the server sends them (the real one does). */
  check: DraftCheck | null; tests: DraftTests | null; history: Array<{ version: number; summary: string; at: number }>;
  status: string | null; scope: string | null; publishedPath: string | null; projectId: string | null;
};

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

const problems = (value: unknown): DraftProblem[] => (Array.isArray(value) ? value.flatMap((item) => (isRaw(item) && typeof item.message === "string" ? [{ level: item.level === "warning" ? "warning" as const : "error" as const, code: str(item.code) ?? "", message: item.message,
  ...(str(item.node) ? { node: str(item.node)! } : {}), ...(num(item.edge) !== null ? { edge: num(item.edge)! } : {}) }] : [])) : []);

/** `null` when the draft does not exist (or the RPC is not there). */
export async function getDraft(rpc: unknown, draftId: string): Promise<DraftDoc | null> {
  try {
    const result = await call(rpc, "workflow_draft_get", { draftId, history: true });
    const top = isRaw(result) ? result : {};
    const summary = isRaw(top.draft) ? top.draft : isRaw(result) ? result : {};
    // The server sends the definition beside the summary; a build (or a test double) that sends only a body is read as one.
    const workflow = top.definition ?? summary.workflow ?? (Array.isArray(summary.nodes) ? summary : null);
    if (!isRaw(workflow)) return null;
    const checkRaw = isRaw(top.check) ? top.check : null;
    const testsRaw = isRaw(top.tests) && Array.isArray(top.tests.results) ? top.tests : null;
    return {
      draftId: str(summary.draftId) ?? str(summary.id) ?? draftId, version: num(summary.version) ?? num(top.version), workflow, threadId: str(summary.threadId), updatedAt: num(summary.updatedAt),
      check: checkRaw ? { valid: checkRaw.valid === true, errors: num(checkRaw.errors) ?? 0, warnings: num(checkRaw.warnings) ?? 0, nodes: num(checkRaw.nodes) ?? 0, edges: num(checkRaw.edges) ?? 0, problems: problems(checkRaw.problems) } : null,
      tests: testsRaw ? { version: num(testsRaw.version) ?? 0, at: num(testsRaw.at) ?? 0, green: testsRaw.green === true, results: (testsRaw.results as unknown[]).flatMap((row) => (isRaw(row) && str(row.caseId) ? [{
        caseId: str(row.caseId)!, green: row.green === true, status: str(row.status) ?? "", path: Array.isArray(row.path) ? row.path.filter((step): step is string => typeof step === "string") : [],
        failures: Array.isArray(row.failures) ? row.failures.filter((line): line is string => typeof line === "string") : [], failedNode: str(row.failedNode),
        notChecked: Array.isArray(row.notChecked) ? row.notChecked.filter((line): line is string => typeof line === "string") : [],
        stubbed: Array.isArray(row.stubbed) ? row.stubbed.flatMap((entry) => (isRaw(entry) && str(entry.node) ? [{ node: str(entry.node)!, type: str(entry.type) ?? "", executor: str(entry.executor) ?? "" }] : [])) : [] }] : [])) } : null,
      history: Array.isArray(top.history) ? top.history.flatMap((row) => (isRaw(row) && num(row.version) !== null ? [{ version: num(row.version)!, summary: str(row.summary) ?? "", at: num(row.at) ?? 0 }] : [])) : [],
      status: str(summary.status), scope: str(summary.scope), publishedPath: str(summary.publishedPath), projectId: str(summary.projectId),
    };
  } catch { return null; }
}

export async function startArchitect(rpc: unknown, projectId: string): Promise<string> {
  const result = await call(rpc, "workflow_architect_start", { projectId });
  const threadId = isRaw(result) ? str(result.threadId) : null;
  if (!threadId) throw new Error("no thread");
  return threadId;
}

/**
 * Backlog to tasks by readiness (SMA atlas D2-9: «Backlog scanner», «No estimate — not issued», «Above 13 — decompose», «Urgency into
 * queue position»). The backlog is the project's `.agents/todos/items/<slug>/meta.yaml` (skill project-life). An item is issued to the
 * project's PM when it is `ready`, has an estimate of at most 13 points and every item it depends on is done; a ready item without an
 * estimate or above 13 is listed for the PM to estimate or split, never issued. Priority, then size, then age, gives the queue position.
 */
export type TodoMeta = { id: string; title: string; status: string; priority: string; estimate: number | null; dependsOn: string[]; created: string; ownsPaths?: string[] };
export const MAX_ESTIMATE = 13;
const PRIORITY: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** Paths of a diff that push a ship lane to «full» instead of the middle batch lane (SMA k_lib_batch risk filter). */
export const FULL_LANE_PATHS = /^(src\/rooms\/(contracts|storage|core)\/|packages\/contracts\/|host\.ts|server\.ts|.*migrations?\.ts)/;
/** An item bigger than a batch-sized estimate ships a fuller lane, never the middle one. */
export const BATCH_MAX_ESTIMATE = 3;

/** The middle lane (SMA k_v_batch): two to four issuable items, none resting on another chosen item. */
export function pickBatch(items: readonly TodoMeta[], max = 4): TodoMeta[] {
  const chosen: TodoMeta[] = [];
  for (const item of backlogBoard(items).issuable) {
    if (chosen.length >= max) break;
    if ((item.estimate ?? 0) > BATCH_MAX_ESTIMATE) continue;
    if (item.dependsOn.some((id) => chosen.some((other) => other.id === id))) continue;
    chosen.push(item);
  }
  return chosen;
}

/** Paths that push a batch item to the full lane: its owns_paths, else the changed paths the task lists. */
export function batchItemIsFullLane(item: Pick<TodoMeta, "ownsPaths">): boolean {
  return (item.ownsPaths ?? []).some((path) => FULL_LANE_PATHS.test(path));
}

/** What a batch item still owes the middle lane (SMA k_lib_batch): the light plan challenge and an accepted attempt. */
export function batchReceiptGaps(record: { state?: string | null; stages?: Array<{ id?: string; state?: string }> } | null): string[] {
  const stages = record?.stages ?? [];
  const gaps: string[] = [];
  if (!stages.some((stage) => stage.id === "plan-critique" && stage.state === "passed")) gaps.push("plan-critique receipt");
  if (record?.state !== "accepted" && !stages.some((stage) => stage.id === "acceptance-receipt" && stage.state === "passed")) gaps.push("accepted attempt receipt");
  return gaps;
}

/** The flat fields of a meta.yaml (scalars and inline lists); anything else is ignored. Null without an id. */
export function parseTodoMeta(text: string): TodoMeta | null {
  const field = (name: string): string | null => {
    const hit = new RegExp(`^${name}:\\s*(.*?)\\s*(?:#.*)?$`, "m").exec(text);
    return hit ? hit[1]!.replace(/^["']|["']$/g, "").trim() : null;
  };
  const list = (name: string): string[] => {
    const raw = field(name);
    if (!raw) return [];
    const inner = /^\[(.*)\]$/.exec(raw)?.[1] ?? raw;
    return inner.split(",").map((item) => item.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  };
  const id = field("id");
  if (!id) return null;
  const estimate = Number(field("estimate"));
  return { id, title: field("title") ?? id, status: field("status") ?? "open", priority: field("priority") ?? "medium",
    estimate: Number.isFinite(estimate) && estimate > 0 ? estimate : null, dependsOn: list("depends_on"), created: field("created") ?? "",
    ...(list("owns_paths").length ? { ownsPaths: list("owns_paths") } : {}) };
}

export type BacklogBoard = { issuable: TodoMeta[]; needsEstimate: TodoMeta[]; decompose: TodoMeta[]; blocked: TodoMeta[] };

/** The ready items sorted into what can be issued (in queue order) and what cannot, and why. */
export function backlogBoard(items: readonly TodoMeta[]): BacklogBoard {
  const done = new Set(items.filter((item) => item.status === "done").map((item) => item.id));
  // Priority band first, the smaller job inside a band (SMA m_in_priority: urgency, then size, then age).
  const order = (a: TodoMeta, b: TodoMeta) => (PRIORITY[a.priority] ?? 1) - (PRIORITY[b.priority] ?? 1)
    || (a.estimate ?? Number.MAX_SAFE_INTEGER) - (b.estimate ?? Number.MAX_SAFE_INTEGER) || a.created.localeCompare(b.created) || a.id.localeCompare(b.id);
  const ready = items.filter((item) => item.status === "ready").sort(order);
  return {
    needsEstimate: ready.filter((item) => item.estimate === null),
    decompose: ready.filter((item) => item.estimate !== null && item.estimate > MAX_ESTIMATE),
    blocked: ready.filter((item) => item.estimate !== null && item.estimate <= MAX_ESTIMATE && item.dependsOn.some((id) => !done.has(id))),
    issuable: ready.filter((item) => item.estimate !== null && item.estimate <= MAX_ESTIMATE && item.dependsOn.every((id) => done.has(id))),
  };
}

/** The PM's message for one issued item. */
export function issueMessage(item: TodoMeta): string {
  return [`Lane Pilot: из беклога проекта готова к работе задача «${item.title}» (${item.id}, оценка ${item.estimate}, приоритет ${item.priority}).`,
    `Описание и подход: .agents/todos/items/${item.id}/AGENT.md и README.md. Составь контракт и отправь писателю; в meta.yaml добавь run в related_runs.`].join("\n");
}

/** Significant word stems of a phrase (≥4 letters, first four characters as the stem). */
const wordStems = (text: string): Set<string> => new Set((text.toLowerCase().match(/[\p{L}\p{N}_]{4,}/gu) ?? []).map((word) => word.slice(0, 4)));

/**
 * The open backlog items whose titles share at least two stems with the phrase (SMA m_sg_breakdown): a new request is
 * compared with what is already written down before a duplicate task is made.
 */
export function backlogMatches(phrase: string, items: readonly TodoMeta[]): TodoMeta[] {
  const stems = wordStems(phrase);
  if (!stems.size) return [];
  return items.filter((item) => item.status !== "done" && [...wordStems(item.title)].filter((stem) => stems.has(stem)).length >= 2);
}

export const BACKLOG_MARK = "__lp_todo__";
/** One read-only shell command that prints every item's meta.yaml with a marker line before it. */
export const backlogReadCommand = `for f in .agents/todos/items/*/meta.yaml; do [ -f "$f" ] || continue; echo "${BACKLOG_MARK} $f"; cat "$f"; echo; done`;

export function parseBacklogOutput(output: string): TodoMeta[] {
  return output.split(`${BACKLOG_MARK} `).slice(1).flatMap((chunk) => { const meta = parseTodoMeta(chunk.slice(chunk.indexOf("\n") + 1)); return meta ? [meta] : []; });
}

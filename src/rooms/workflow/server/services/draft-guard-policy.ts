import {
  formatPermissionDiffSummary,
  isLearnedDraftSource,
  permissionDiff,
  type DraftMetadata,
  type DraftRow,
  type DraftStore,
  type PermissionDiffEntry,
  type RawDefinition,
  type Workflow,
} from "@lane-pilot/workflow-engine";
import { closeOwnerItemsByPrefix, postOwnerItem, rpcLine } from "../../../owner-waiting";
import type { LanePilotDatabase } from "../../../storage";

export type GuardLog = {
  warn: (message: string) => void;
  info: (message: string) => void;
};

/** Adapts `ServerCore` logging to a warn/info sink for draft-guard messages. */
export function makeGuardLog(ctx: { bb?: { log?: { warn?: (m: string) => void; info?: (m: string) => void } }; log: (m: string) => void }): GuardLog {
  return {
    warn: (m) => { if (ctx.bb?.log?.warn) ctx.bb.log.warn(m); else ctx.log(m); },
    info: (m) => { if (ctx.bb?.log?.info) ctx.bb.log.info(m); else ctx.log(m); },
  };
}

const WIDENS_KEY_SUFFIX = ":widens";

export const wideningOwnerItemKey = (draftId: string): string => `workflow-draft:${draftId}${WIDENS_KEY_SUFFIX}`;

function cleanMetadata(meta: DraftMetadata): DraftMetadata {
  const next: DraftMetadata = { ...meta };
  for (const key of Object.keys(next)) {
    if (next[key] === undefined) delete next[key];
  }
  return next;
}

/** Posts or refreshes the owner desk item for a learned draft that widens permissions. */
export function postWideningDeskItem(
  db: LanePilotDatabase,
  draft: Pick<DraftRow, "id" | "projectId" | "workflowId">,
  source: string,
  diffs: readonly PermissionDiffEntry[],
): void {
  const summary = formatPermissionDiffSummary(diffs);
  const projectId = draft.projectId && draft.projectId !== "*" ? draft.projectId : null;
  postOwnerItem(db, {
    key: wideningOwnerItemKey(draft.id),
    source: "learning",
    kind: "workflow_draft_widens",
    reason: "decision",
    projectId,
    what: `Черновик ${draft.workflowId} (${source}) расширяет права (${diffs.length})`,
    why: `Learned diff widens permissions: ${summary}`,
    evidence: [{ kind: "note", ref: draft.id, label: summary.slice(0, 200) }],
    actions: [
      {
        id: "grant",
        label: "Одобрить расширение прав",
        cli: rpcLine("workflow_draft_grant", { draftId: draft.id }),
        rpc: { method: "workflow_draft_grant", input: { draftId: draft.id } },
      },
    ],
  });
}

/** Resolves the baseline definition to compare a learned draft against when checking for widening. */
export function resolveDraftGuardBase(input: {
  draft?: DraftRow;
  drafts?: DraftStore;
  branchOf?: string;
  source?: string;
  resolve: (id: string, version?: number) => Workflow | null;
  fallbackWorkflow?: Workflow | RawDefinition | null;
}): Workflow | RawDefinition | null {
  const branchOf = input.branchOf ?? (typeof input.draft?.metadata?.branchOf === "string" ? input.draft.metadata.branchOf : undefined);
  if (branchOf) {
    const resolved = input.resolve(branchOf) ?? input.fallbackWorkflow ?? null;
    if (resolved) return resolved;
  }
  if (input.draft && input.drafts) {
    const v1 = input.drafts.definitionAt(input.draft.id, 1);
    if (v1 && Array.isArray(v1.nodes) && v1.nodes.length > 0) return v1;
  }
  return null;
}

/**
 * Checks permission widening for learned drafts on `createFrom` or `patch`:
 * flags `needs_owner_review: "widens"` + posts desk item, or clears the flag if a follow-up patch removes widening.
 */
export function evaluateLearnedDraftGuard(input: {
  db: LanePilotDatabase;
  drafts: DraftStore;
  draft: DraftRow;
  source: string | undefined;
  base: Workflow | RawDefinition | null;
  log: GuardLog;
}): DraftRow {
  const { db, drafts, draft, source, base, log } = input;
  if (!isLearnedDraftSource(source) || source === "evolve") return draft;

  const diffs = permissionDiff(base, draft.definition);
  if (diffs.length > 0) {
    log.warn(`draft guard source=${source} draft=${draft.id} widening=${diffs.length}`);
    const nextMeta = cleanMetadata({
      ...(draft.metadata ?? {}),
      needs_owner_review: "widens",
      wideningDiff: diffs,
      ownerGrantedAt: undefined,
      ownerGrantedBy: undefined,
    });
    const updated = drafts.setMetadata(draft.id, nextMeta) ?? draft;
    postWideningDeskItem(db, updated, source, diffs);
    return updated;
  }

  if (draft.metadata?.needs_owner_review === "widens") {
    const nextMeta = cleanMetadata({
      ...(draft.metadata ?? {}),
      needs_owner_review: undefined,
      wideningDiff: undefined,
    });
    const updated = drafts.setMetadata(draft.id, nextMeta) ?? draft;
    closeOwnerItemsByPrefix(db, wideningOwnerItemKey(draft.id), "guard:cleared");
    return updated;
  }

  return draft;
}

/** Records an explicit owner grant for a flagged learned draft and closes its desk item. */
export function grantFlaggedDraft(input: {
  db: LanePilotDatabase;
  drafts: DraftStore;
  draft: DraftRow;
  by?: string;
  now?: number;
  log: GuardLog;
}): DraftRow {
  const { db, drafts, draft, log } = input;
  const by = input.by?.trim() || "owner";
  const now = input.now ?? Date.now();
  const nextMeta = cleanMetadata({
    ...(draft.metadata ?? {}),
    needs_owner_review: undefined,
    ownerGrantedAt: now,
    ownerGrantedBy: by,
  });
  const updated = drafts.setMetadata(draft.id, nextMeta) ?? draft;
  closeOwnerItemsByPrefix(db, wideningOwnerItemKey(draft.id), `approved:${by}`);
  log.info(`draft guard owner granted draft=${draft.id} workflow=${draft.workflowId} by=${by}`);
  return updated;
}

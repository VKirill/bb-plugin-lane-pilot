import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { createDraftStore, type DraftStore } from "@lane-pilot/workflow-engine";
import type { ServerCore } from "../../../contracts/server";
import { approveHypothesis, rejectHypothesis, type DecideDeps } from "../../../evolve/server";
import { acceptRoad, laterRoad, rejectRoad } from "../../../lead/server";
import { closeOwnerItem } from "../../../owner-waiting";
import { loadPushConfig } from "../../../owner-waiting/server";
import { activateSharedRule, grantAutonomy } from "../../../specialist/server";
import { readLoopModes, saveProjectSetting, type LanePilotDatabase } from "../../../storage";
import {
  grantFlaggedDraft,
  grantOwner,
  makeGuardLog,
  publishGateLog,
  saveBranch,
  savePath,
  type SavePathDeps,
  type WorkflowArchitect,
} from "../../../workflow/server";
import {
  DESK_KEEP_OPTIONS,
  deskWeekKey,
  normalizeDeskOption,
  reviewDeskOwnerItemKey,
  type DeskItem,
} from "../../models/review-desk";
import { LOOPS_MODE_KEY } from "../../settings";
import {
  composeReviewDesk,
  emitDeskInfo,
  emitDeskWarn,
  type ComposeReviewDeskDeps,
  type ReviewDeskLogger,
} from "./review-desk";

export type DeskAnswerDeps = {
  bb?: ServerCore["bb"];
  now?: () => number;
  log?: ReviewDeskLogger;
  reason?: string;
  draftStore?: DraftStore;
  architect?: Partial<Pick<WorkflowArchitect, "create" | "createFrom" | "publish">>;
  /** Resolves project and global graphs; without it a branch of a project graph is unknown_graph. */
  loadWorkflow?: SavePathDeps["loadWorkflow"];
  publishDraft?: (input: { projectId: string; draftId: string; ownerGrant?: boolean }) => Promise<unknown>;
  evolveDeps?: DecideDeps;
  composeDeps?: ComposeReviewDeskDeps;
};

export type DeskAnswerResult =
  | { ok: true; itemId: string; option: string; applied: boolean; detail?: string }
  | { ok: false; itemId: string; reason: string };

export type DeskAcceptDefaultsResult = {
  week: string;
  total: number;
  applied: number;
  kept: number;
  failed: Array<{ itemId: string; reason: string }>;
};

async function handleRoadAnswer(
  db: LanePilotDatabase,
  item: DeskItem & { action: Extract<DeskItem["action"], { kind: "road" }> },
  option: string,
  deps: DeskAnswerDeps,
  now: number,
): Promise<DeskAnswerResult> {
  const { roadId, roadClass, projectId, payload } = item.action;
  if (option === "later") {
    const ok = laterRoad(db, roadId, "owner", now);
    return ok ? { ok: true, itemId: item.id, option, applied: true, detail: "later" } : { ok: false, itemId: item.id, reason: "road_not_updated" };
  }
  if (option === "reject") {
    const why = deps.reason && deps.reason.trim().length >= 10 ? deps.reason.trim() : "rejected via weekly review desk";
    const ok = rejectRoad(db, roadId, why, "owner", now);
    return ok ? { ok: true, itemId: item.id, option, applied: true, detail: "rejected" } : { ok: false, itemId: item.id, reason: "road_not_updated" };
  }

  let draftId: string | null = null;
  const ctxLike = { db, log: (m: string) => emitDeskInfo(deps.log, m), ...(deps.bb ? { bb: deps.bb } : {}) };
  const graphId = typeof payload?.graphId === "string" ? payload.graphId : null;
  const candidateKey = typeof payload?.key === "string" ? payload.key : null;
  const runIds = Array.isArray(payload?.runIds) ? payload.runIds.filter((r): r is string => typeof r === "string") : [];

  if (roadClass === "branch" && graphId && candidateKey && deps.architect?.createFrom) {
    const saved = await saveBranch(ctxLike, { architect: deps.architect as WorkflowArchitect, ...(deps.loadWorkflow ? { loadWorkflow: deps.loadWorkflow } : {}) }, { graphId, candidateKey, ...(projectId ? { projectId } : {}), now });
    if (saved.ok) draftId = saved.draftId;
  } else if (runIds.length > 0 && deps.architect?.create) {
    const saved = await savePath(ctxLike, { architect: deps.architect as WorkflowArchitect, ...(deps.loadWorkflow ? { loadWorkflow: deps.loadWorkflow } : {}) }, { runId: runIds[0]!, projectId: projectId ?? GLOBAL_SETTINGS_PROJECT_ID });
    if (saved.ok) draftId = saved.draftId;
  }

  if (!draftId) {
    const source = roadClass === "branch" ? "branch-capture" : "path-capture";
    if (deps.architect?.create) {
      const created = await deps.architect.create({
        projectId: projectId ?? GLOBAL_SETTINGS_PROJECT_ID,
        threadId: "",
        name: item.title.slice(0, 80),
        description: item.title,
        scope: projectId ? "project" : "global",
        metadata: { source, roadId },
      });
      if ("draftId" in created) draftId = created.draftId;
    } else {
      const draftStore = deps.draftStore ?? createDraftStore(db, () => now);
      const created = draftStore.create({
        projectId: projectId ?? GLOBAL_SETTINGS_PROJECT_ID,
        threadId: null,
        scope: projectId ? "project" : "global",
        name: item.title.slice(0, 80),
        description: item.title,
        metadata: { source, roadId },
      });
      draftId = created.id;
    }
  }

  const ok = acceptRoad(db, roadId, draftId ? `saved draft ${draftId}` : "saved as draft", "owner", now);
  return ok
    ? { ok: true, itemId: item.id, option, applied: true, ...(draftId ? { detail: draftId } : {}) }
    : { ok: false, itemId: item.id, reason: "road_not_updated" };
}

async function handleDraftAnswer(
  db: LanePilotDatabase,
  item: DeskItem & { action: Extract<DeskItem["action"], { kind: "draft" }> },
  option: string,
  deps: DeskAnswerDeps,
  now: number,
): Promise<DeskAnswerResult> {
  if (option === "keep draft") {
    return { ok: true, itemId: item.id, option, applied: false, detail: "kept" };
  }
  const draftStore = deps.draftStore ?? createDraftStore(db, () => now);
  const { draftId, projectId, threadId } = item.action;

  if (option === "delete") {
    const deleted = draftStore.delete(draftId);
    return deleted ? { ok: true, itemId: item.id, option, applied: true, detail: "deleted" } : { ok: false, itemId: item.id, reason: "draft_not_found" };
  }

  const draft = draftStore.get(draftId);
  if (!draft) return { ok: false, itemId: item.id, reason: "draft_not_found" };

  const gateLog = publishGateLog({ log: (m) => emitDeskInfo(deps.log, m) });
  const grant = grantOwner(db, draftId, "desk", { now, log: gateLog });
  if (!grant) return { ok: false, itemId: item.id, reason: "grant_failed" };

  if (deps.publishDraft) {
    await deps.publishDraft({ projectId, draftId, ownerGrant: true });
    return { ok: true, itemId: item.id, option, applied: true, detail: "published" };
  }
  if (deps.architect?.publish && draft.status === "tested") {
    const pub = await deps.architect.publish({
      projectId,
      ...(threadId ? { threadId } : {}),
      draftId,
      ownerGrant: true,
    });
    if (!pub.published) {
      return { ok: false, itemId: item.id, reason: String((pub as { reason?: unknown }).reason ?? "publish_refused") };
    }
    return { ok: true, itemId: item.id, option, applied: true, detail: "published" };
  }

  return { ok: true, itemId: item.id, option, applied: true, detail: `granted:${grant.draftSha256.slice(0, 8)}` };
}

async function applyDeskItemOption(
  db: LanePilotDatabase,
  item: DeskItem,
  option: string,
  deps: DeskAnswerDeps,
  now: number,
): Promise<DeskAnswerResult> {
  if (DESK_KEEP_OPTIONS.has(option)) {
    return { ok: true, itemId: item.id, option, applied: false, detail: "kept" };
  }

  switch (item.action.kind) {
    case "road":
      return handleRoadAnswer(db, item as DeskItem & { action: Extract<DeskItem["action"], { kind: "road" }> }, option, deps, now);
    case "draft":
      return handleDraftAnswer(db, item as DeskItem & { action: Extract<DeskItem["action"], { kind: "draft" }> }, option, deps, now);
    case "evolve": {
      const ctxLike = { db, ...(deps.bb ? { bb: deps.bb } : {}), log: (m: string) => emitDeskInfo(deps.log, m) };
      if (option === "approve") {
        const res = await approveHypothesis(ctxLike, deps.evolveDeps ?? {}, { hypothesisId: item.action.hypothesisId });
        return res.ok ? { ok: true, itemId: item.id, option, applied: true, detail: res.mode } : { ok: false, itemId: item.id, reason: res.reason };
      }
      const res = rejectHypothesis(ctxLike, { now: () => now }, { hypothesisId: item.action.hypothesisId });
      return res.ok ? { ok: true, itemId: item.id, option, applied: true, detail: res.mode } : { ok: false, itemId: item.id, reason: res.reason };
    }
    case "autonomy": {
      const res = grantAutonomy(
        db,
        {
          projectId: item.action.projectId,
          domain: item.action.domain,
          actionClass: item.action.actionClass,
          by: "owner",
          reason: deps.reason ?? "approved via weekly review desk",
          now,
        },
        { info: (m) => emitDeskInfo(deps.log, m), warn: (m) => emitDeskWarn(deps.log, m) },
      );
      return res.ok ? { ok: true, itemId: item.id, option, applied: true, detail: res.autonomyClass } : { ok: false, itemId: item.id, reason: res.reason };
    }
    case "shared_rule": {
      const res = activateSharedRule(
        db,
        item.action.ruleId,
        "owner",
        { nowMs: now, log: { info: (m) => emitDeskInfo(deps.log, m), warn: (m) => emitDeskWarn(deps.log, m) } },
      );
      return res.ok ? { ok: true, itemId: item.id, option, applied: true, detail: res.state } : { ok: false, itemId: item.id, reason: res.reason };
    }
    case "deferred": {
      const matched = item.action.actions.find((a) => a.id === option);
      if (matched?.rpc?.method === "workflow_draft_grant" && typeof matched.rpc.input.draftId === "string") {
        const draftId = matched.rpc.input.draftId;
        const draftStore = deps.draftStore ?? createDraftStore(db, () => now);
        const draft = draftStore.get(draftId);
        if (draft) {
          const guardLog = makeGuardLog({ log: (m) => emitDeskInfo(deps.log, m) });
          grantFlaggedDraft({ db, drafts: draftStore, draft, by: "owner", now, log: guardLog });
        }
        grantOwner(db, draftId, "desk", { now, log: publishGateLog({ log: (m) => emitDeskInfo(deps.log, m) }) });
      }
      const closed = closeOwnerItem(db, item.action.ownerItemKey, `owner:desk:${option}`, now);
      return { ok: true, itemId: item.id, option, applied: closed, detail: closed ? "closed" : "already_closed" };
    }
    case "loop_health": {
      const nextMode = option === "turn off" ? "off" : "report";
      const current = readLoopModes(db, GLOBAL_SETTINGS_PROJECT_ID);
      saveProjectSetting(db, GLOBAL_SETTINGS_PROJECT_ID, LOOPS_MODE_KEY, { ...current, [item.action.loop]: nextMode });
      return { ok: true, itemId: item.id, option, applied: true, detail: `${item.action.loop}=${nextMode}` };
    }
    case "noop":
      return { ok: true, itemId: item.id, option, applied: false, detail: "noop" };
  }
}

/** Routes a single owner answer `bb lane-pilot desk answer <itemId> <option>` to the owning room's handler. */
export async function answerDeskItem(
  db: LanePilotDatabase,
  input: { itemId: string; option: string },
  deps: DeskAnswerDeps = {},
): Promise<DeskAnswerResult> {
  const now = (deps.now ?? Date.now)();
  const desk = composeReviewDesk(db, deps.composeDeps, { now });
  const item = desk.items.find((entry) => entry.id === input.itemId);
  if (!item) {
    return { ok: false, itemId: input.itemId, reason: "item_not_found" };
  }
  const normalized = normalizeDeskOption(item, input.option);
  if (!normalized) {
    return { ok: false, itemId: item.id, reason: `invalid_option:${item.options.join("|")}` };
  }
  emitDeskInfo(deps.log, `desk answer item=${item.id} option=${normalized}`);
  return applyDeskItemOption(db, item, normalized, deps, now);
}

/** Applies only the pre-selected defaults for all current desk items; `"keep*"` defaults change nothing. */
export async function acceptDeskDefaults(
  db: LanePilotDatabase,
  deps: DeskAnswerDeps = {},
): Promise<DeskAcceptDefaultsResult> {
  const now = (deps.now ?? Date.now)();
  const desk = composeReviewDesk(db, deps.composeDeps, { now });
  let applied = 0;
  let kept = 0;
  const failed: Array<{ itemId: string; reason: string }> = [];

  for (const item of desk.items) {
    if (DESK_KEEP_OPTIONS.has(item.default)) {
      kept += 1;
      continue;
    }
    emitDeskInfo(deps.log, `desk answer item=${item.id} option=${item.default}`);
    const res = await applyDeskItemOption(db, item, item.default, deps, now);
    if (!res.ok) {
      failed.push({ itemId: item.id, reason: res.reason });
    } else if (res.applied) {
      applied += 1;
    } else {
      kept += 1;
    }
  }

  let tz = "UTC";
  try { tz = loadPushConfig(db).timezone; } catch { /* fallback UTC */ }
  const week = desk.week || deskWeekKey(now, tz);
  closeOwnerItem(db, reviewDeskOwnerItemKey(week), "owner:desk:accept-defaults", now);

  return { week, total: desk.items.length, applied, kept, failed };
}

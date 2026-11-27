import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { ReviewDeskItem, rpcContract } from "../../../contracts";
import type { ServerCore } from "../../../contracts/server";
import { loadPushConfig, readOwnerConfigKey, writeOwnerConfigKey } from "../../../owner-waiting/server";
import { fireTimes } from "../../../schedule";
import { DESK_SECTIONS, type DeskItem } from "../../models/review-desk";
import { composeReviewDesk, type ComposeReviewDeskDeps, type ReviewDeskLogger } from "../services/review-desk";
import { acceptDeskDefaults, answerDeskItem, type DeskAnswerDeps } from "../services/review-desk-answers";

const REVIEW_DESK_CRON = "0 10 * * 1";
const DESK_ANSWERS_KEY_PREFIX = "review-desk:answers:";

export type DeskRpcDeps = ComposeReviewDeskDeps & {
  now?: () => number;
  answerDeps?: Partial<DeskAnswerDeps>;
};

/** Computes the next Monday 10:00 timestamp in `timezone` matching the `review-desk` schedule. */
export function nextDeskDefaultAt(now: number, timezone: string): number {
  try {
    const next = fireTimes(REVIEW_DESK_CRON, timezone, now, { limit: 1 })[0];
    if (typeof next === "number" && Number.isFinite(next)) return next;
  } catch {
    // Fall back to UTC if the stored timezone is not a valid IANA zone.
  }
  return fireTimes(REVIEW_DESK_CRON, "UTC", now, { limit: 1 })[0] ?? now;
}

function deskItemEvidence(item: DeskItem): string | null {
  switch (item.action.kind) {
    case "road": {
      const key = item.action.payload?.key;
      return typeof key === "string" && key.trim() ? key.trim() : item.action.roadId;
    }
    case "draft":
      return `draft:${item.action.draftId}`;
    case "evolve":
      return `hypothesis:${item.action.hypothesisId}`;
    case "autonomy":
      return `${item.action.projectId}/${item.action.domain}:${item.action.actionClass}`;
    case "shared_rule":
      return `rule:${item.action.ruleId}`;
    case "deferred":
      return item.action.ownerItemKey;
    case "loop_health":
      return `loop:${item.action.loop}`;
    case "noop":
      return null;
  }
}

function toReviewDeskItem(item: DeskItem, defaultAt: number, answered: string | null = null): ReviewDeskItem {
  return {
    id: item.id,
    section: item.section,
    question: item.title,
    evidence: deskItemEvidence(item),
    options: item.options.map((opt) => ({
      id: opt,
      label: opt,
      isDefault: opt === item.default,
    })),
    answered,
    defaultAt,
  };
}

function readStoredDeskAnswers(db: ServerCore["db"], week: string): Record<string, ReviewDeskItem> {
  const raw = readOwnerConfigKey(db, `${DESK_ANSWERS_KEY_PREFIX}${week}`);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, ReviewDeskItem>;
  } catch {
    return {};
  }
}

function writeStoredDeskAnswers(
  db: ServerCore["db"],
  week: string,
  answers: Record<string, ReviewDeskItem>,
  now: number,
): void {
  writeOwnerConfigKey(db, `${DESK_ANSWERS_KEY_PREFIX}${week}`, JSON.stringify(answers), now);
}

function sortDeskItems(items: ReviewDeskItem[]): ReviewDeskItem[] {
  const order = new Map<string, number>(DESK_SECTIONS.map((s, idx) => [s, idx]));
  return [...items].sort((a, b) => (order.get(a.section) ?? 99) - (order.get(b.section) ?? 99));
}

function resolveDeskCallContext(ctx: ServerCore, deps: DeskRpcDeps) {
  const now = deps.now ? deps.now() : Date.now();
  let timezone = deps.timezone;
  if (!timezone) {
    try {
      timezone = loadPushConfig(ctx.db).timezone;
    } catch {
      timezone = "UTC";
    }
  }
  const log: Exclude<ReviewDeskLogger, (...args: never[]) => unknown> =
    typeof deps.log === "function"
      ? { info: deps.log, warn: deps.log, debug: deps.log }
      : (deps.log ?? {
          info: (message: string) => ctx.bb.log.info(message),
          warn: (message: string) => ctx.log(message),
          debug: (message: string) => ctx.bb.log.debug(message),
        });
  const composeDeps: ComposeReviewDeskDeps = { ...deps, timezone, log };
  const answerDeps: DeskAnswerDeps = {
    bb: ctx.bb,
    log,
    now: () => now,
    composeDeps,
    ...deps.answerDeps,
  };
  return { now, timezone, log, composeDeps, answerDeps };
}

/** Console RPC handlers backed by the reports room (`desk_get`, `desk_answer`, `desk_accept_defaults`). */
export function deskRpc(ctx: ServerCore, deps: DeskRpcDeps = {}) {
  return {
    desk_get: async ({ week }) => {
      const { now, timezone, composeDeps } = resolveDeskCallContext(ctx, deps);
      const desk = composeReviewDesk(ctx.db, composeDeps, { now });
      if (week && week !== desk.week) {
        const stored = readStoredDeskAnswers(ctx.db, week);
        return { week, items: sortDeskItems(Object.values(stored)) };
      }
      const defaultAt = nextDeskDefaultAt(now, timezone);
      const stored = readStoredDeskAnswers(ctx.db, desk.week);
      const seenIds = new Set<string>();
      const items: ReviewDeskItem[] = desk.items.map((item) => {
        seenIds.add(item.id);
        return toReviewDeskItem(item, defaultAt, stored[item.id]?.answered ?? null);
      });
      for (const item of Object.values(stored)) {
        if (!seenIds.has(item.id)) items.push(item);
      }
      return { week: desk.week, items: sortDeskItems(items) };
    },

    desk_answer: async ({ itemId, option }) => {
      const { now, timezone, log, composeDeps, answerDeps } = resolveDeskCallContext(ctx, deps);
      const desk = composeReviewDesk(ctx.db, composeDeps, { now });
      const target = desk.items.find((entry) => entry.id === itemId);
      const res = await answerDeskItem(ctx.db, { itemId, option }, answerDeps);
      if (!res.ok) {
        log.warn?.(`[desk] answer refused item=${itemId} reason=${res.reason}`);
        return { ok: false as const, reason: res.reason };
      }
      const defaultAt = nextDeskDefaultAt(now, timezone);
      const stored = readStoredDeskAnswers(ctx.db, desk.week);
      const item: ReviewDeskItem = target
        ? toReviewDeskItem(target, defaultAt, res.option)
        : {
            id: res.itemId,
            section: stored[res.itemId]?.section ?? "deferred",
            question: stored[res.itemId]?.question ?? res.itemId,
            evidence: stored[res.itemId]?.evidence ?? null,
            options: stored[res.itemId]?.options ?? [{ id: res.option, label: res.option, isDefault: false }],
            answered: res.option,
            defaultAt,
          };
      stored[item.id] = item;
      writeStoredDeskAnswers(ctx.db, desk.week, stored, now);
      log.info?.(`[desk] answer item=${res.itemId} option=${res.option}`);
      return { ok: true as const, item };
    },

    desk_accept_defaults: async ({ week }) => {
      const { now, timezone, log, composeDeps, answerDeps } = resolveDeskCallContext(ctx, deps);
      const desk = composeReviewDesk(ctx.db, composeDeps, { now });
      if (week !== desk.week) {
        log.warn?.(`[desk] accept-defaults week mismatch requested=${week} current=${desk.week}`);
        return { ok: false, accepted: 0 };
      }
      const defaultAt = nextDeskDefaultAt(now, timezone);
      const stored = readStoredDeskAnswers(ctx.db, desk.week);
      const openItems = desk.items.filter((item) => !stored[item.id]);
      const res = await acceptDeskDefaults(ctx.db, answerDeps);
      const failedIds = new Set(res.failed.map((f) => f.itemId));
      let accepted = 0;
      for (const item of openItems) {
        if (failedIds.has(item.id)) continue;
        stored[item.id] = toReviewDeskItem(item, defaultAt, item.default);
        accepted += 1;
      }
      if (accepted > 0) writeStoredDeskAnswers(ctx.db, desk.week, stored, now);
      log.info?.(`[desk] accept-defaults week=${desk.week} n=${accepted}`);
      return { ok: res.failed.length === 0, accepted };
    },
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "desk_get" | "desk_answer" | "desk_accept_defaults">;
}

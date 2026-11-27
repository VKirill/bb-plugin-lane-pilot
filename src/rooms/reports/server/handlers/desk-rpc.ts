import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { ReviewDeskItem, rpcContract } from "../../../contracts";
import type { ServerCore } from "../../../contracts/server";
import { loadPushConfig } from "../../../owner-waiting/server";
import { fireTimes } from "../../../schedule";
import type { DeskItem } from "../../models/review-desk";
import { composeReviewDesk, type ComposeReviewDeskDeps } from "../services/review-desk";

const REVIEW_DESK_CRON = "0 10 * * 1";

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

/** Console RPC handlers backed by the reports room (`desk_get`). */
export function deskRpc(
  ctx: ServerCore,
  deps: ComposeReviewDeskDeps & { now?: () => number } = {},
) {
  return {
    desk_get: async ({ week }) => {
      const now = deps.now ? deps.now() : Date.now();
      let timezone = deps.timezone;
      if (!timezone) {
        try {
          timezone = loadPushConfig(ctx.db).timezone;
        } catch {
          timezone = "UTC";
        }
      }
      const log = deps.log ?? {
        info: (message: string) => ctx.bb.log.info(message),
        warn: (message: string) => ctx.log(message),
        debug: (message: string) => ctx.bb.log.debug(message),
      };
      const desk = composeReviewDesk(ctx.db, { ...deps, timezone, log }, { now });
      if (week && week !== desk.week) {
        return { week, items: [] };
      }
      const defaultAt = nextDeskDefaultAt(now, timezone);
      const items: ReviewDeskItem[] = desk.items.map((item) => ({
        id: item.id,
        section: item.section,
        question: item.title,
        evidence: deskItemEvidence(item),
        options: item.options.map((opt) => ({
          id: opt,
          label: opt,
          isDefault: opt === item.default,
        })),
        answered: null,
        defaultAt,
      }));
      return { week: desk.week, items };
    },
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "desk_get">;
}

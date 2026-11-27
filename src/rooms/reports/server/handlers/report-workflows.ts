import type { StepContext, WorkflowEngine } from "@lane-pilot/workflow-engine";
import type { ServerCore } from "../../../contracts/server";
import { loadPushConfig } from "../../../owner-waiting/server";
import type { DigestLike } from "../../models/owner-push";
import type { TelegramSend } from "../../models/telegram";
import { runDailyReport, type PathCandidatesReader } from "../services/daily-report";
import { runOwnerPush } from "../services/owner-push";
import { runReviewDesk, type ComposeReviewDeskDeps } from "../services/review-desk";
import { createTelegramSender } from "../services/telegram";

export type ReportsDeps = {
  engine?: WorkflowEngine;
  digest: () => Promise<DigestLike>;
  ack: (keys: string[]) => Promise<unknown> | unknown;
  send?: TelegramSend;
  now?: () => number;
  pathCandidates?: PathCandidatesReader;
  reviewDesk?: ComposeReviewDeskDeps;
};

/**
 * Registers the calendar-driven report step executors (`lp.owner_push`, `lp.daily_report`, and `lp.review_desk`) on the workflow engine.
 * Scheduling lives in `SYSTEM_SCHEDULES` so the owner sees and can pause them.
 */
export function mountReports(ctx: ServerCore, deps: ReportsDeps): void {
  if (!deps.engine) return;
  const send = deps.send ?? createTelegramSender({ secrets: ctx.secrets });
  const nowFn = () => deps.now?.() ?? deps.engine!.now();

  deps.engine.register("lp.owner_push", {
    reentrant: true,
    run: async () => {
      if (ctx.isDisposed()) return { output: { sent: false, reason: "disposed" } };
      const outcome = await runOwnerPush({
        digest: deps.digest,
        ack: deps.ack,
        send,
        dryRun: () => loadPushConfig(ctx.db).dryRun === true,
        log: ctx.log,
      });
      return { output: { sent: outcome.status === "sent", reason: outcome.reason ?? "" } };
    },
  });

  deps.engine.register("lp.daily_report", {
    reentrant: true,
    run: async (step: StepContext) => {
      if (ctx.isDisposed()) return { output: { sent: false, reason: "disposed", day: "" } };
      const output = await runDailyReport({
        db: ctx.db,
        now: nowFn(),
        force: Boolean(step.inputs?.force),
        send,
        log: ctx.log,
        pathCandidates: deps.pathCandidates,
      });
      return { output };
    },
  });

  deps.engine.register("lp.review_desk", {
    reentrant: true,
    run: async () => {
      if (ctx.isDisposed()) return { output: { sent: false, reason: "disposed", week: "", items: 0 } };
      const output = await runReviewDesk({
        db: ctx.db,
        now: nowFn(),
        send,
        log: ctx.log,
        composeDeps: deps.reviewDesk,
      });
      return { output: { sent: output.sent, reason: output.reason, week: output.week, items: output.items } };
    },
  });
}

import { z } from "zod";
import { callerPluginMetadata, ToolError, registerObservedTool, type ServerCore } from "../../core/server";
import { hostContract } from "../../contracts";
import { failureClass } from "../../runs";
import { getRun, getRunWriterHost } from "../../storage";
import { checkRecipe, factKind, type CheckMeasure } from "../rails";

/**
 * The turn engine and the checks from the conversation (SMA map: Conversation and intake — One-turn engine, What kind of question,
 * Task status — the board, What ate the limit — arithmetic, Question about the past — books, Failure reason by dictionary; Checks from the
 * conversation — Whole request selects a recipe, Three check recipes, A check as an operation, Five required measures, Stop a check).
 * The PM asks code for the facts before it answers; the owner's «проверь …» runs as an operation with every measure on record.
 */
export function registerConversationTools(ctx: ServerCore): void {
  const { db, bb } = ctx;
  const running = new Map<string, AbortController>();

  const runOf = async (context: { threadId: string | null; experimental_vkPluginMetadata?: unknown }) => {
    const metadata = await callerPluginMetadata(bb, context);
    return typeof metadata?.lanePilotRunId === "string" ? metadata.lanePilotRunId : null;
  };

  registerObservedTool(bb.agents, {
    name: "lane_pilot_facts",
    description: "Answer the owner's question about tasks, limits, the past or a failure from Lane Pilot's records, by code, before you answer in words.",
    instructions: "Pass the owner's question as is. Lane Pilot names its kind (board, limit, history, failure, free) and returns the facts for it: the board of this run, the tokens spent today per provider and model, the last finished tasks, the last failures with their class. Answer from these facts and name their sources (the answer's `sources`) at the end of your reply; for kind free there are none and you answer from your reading.",
    parameters: z.object({ question: z.string().trim().min(1).max(2000) }).strict(),
    execute: async (input, context) => {
      const kind = factKind(input.question);
      const runId = await runOf(context);
      if (kind === "board") {
        const rows = db.prepare(`SELECT t.id AS taskId, COALESCE(json_extract(t.contract_json,'$.display_title'), json_extract(t.contract_json,'$.title')) AS title,
          (SELECT a.state FROM lane_pilot_attempt a WHERE a.task_id=t.id ORDER BY a.created_at DESC LIMIT 1) AS state
          FROM lane_pilot_task t WHERE t.run_id=? ORDER BY t.created_at DESC LIMIT 60`).all(runId ?? "") as Array<{ taskId: string; title: string; state: string | null }>;
        const counts: Record<string, number> = {};
        for (const row of rows) counts[row.state ?? "queued"] = (counts[row.state ?? "queued"] ?? 0) + 1;
        return JSON.stringify({ kind, runId, counts, tasks: rows, sources: [`the run board (lane_pilot_attempt, run ${runId})`] });
      }
      if (kind === "limit") {
        const day = new Date().toISOString().slice(0, 10);
        const rows = db.prepare("SELECT provider_id AS provider, model, SUM(total_tokens) AS tokens FROM lane_pilot_token_daily WHERE project_id=? AND day=? GROUP BY provider_id, model ORDER BY tokens DESC").all(context.projectId, day);
        return JSON.stringify({ kind, day, byModel: rows, sources: [`the spend book (lane_pilot_token_daily, ${day})`] });
      }
      if (kind === "history") {
        const rows = db.prepare(`SELECT a.task_id AS taskId, a.state, a.updated_at AS at FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
          WHERE r.project_id=? AND a.state IN ('accepted','blocked','canceled') ORDER BY a.updated_at DESC LIMIT 15`).all(context.projectId) as Array<{ taskId: string; state: string; at: number }>;
        return JSON.stringify({ kind, finished: rows.map((row) => ({ ...row, at: new Date(row.at).toISOString() })), sources: ["the finished attempts (lane_pilot_attempt)"] });
      }
      if (kind === "failure") {
        const rows = db.prepare(`SELECT a.task_id AS taskId, a.state, a.reason, a.updated_at AS at FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
          WHERE r.project_id=? AND a.state IN ('validation_failed','blocked','provider_error','timeout','empty_output') ORDER BY a.updated_at DESC LIMIT 10`).all(context.projectId) as Array<{ taskId: string; state: string; reason: string | null; at: number }>;
        return JSON.stringify({ kind, failures: rows.map((row) => ({ ...row, class: failureClass(row.state, row.reason), reason: (row.reason ?? "").slice(0, 300), at: new Date(row.at).toISOString() })), sources: ["the failed attempts and their failure class (lane_pilot_attempt)"] });
      }
      return JSON.stringify({ kind, facts: null, note: "no code answer for this kind of question: answer from your reading" });
    },
  });

  registerObservedTool(bb.agents, {
    name: "lane_pilot_check",
    description: "Run a check the owner asked for in the chat as an operation: the request selects the recipe (quick, full, browser) and every result carries its five measures.",
    instructions: "`run` (request: the owner's words; commands: for quick, the commands to run in the run's checkout, each with cwd relative to it and timeoutSec): quick runs them in the sandbox and returns per command the five measures — command, folder, expected exit, time limit, evidence (the output tail) — and passed. A request for the whole suite selects full: send the run's accepted tasks to the run-goal check (bb lane-pilot run-goal) instead; a request about a page selects browser: use lane_pilot_helpers {action:\"browser_qa\"}. `stop` (checkId) stops a running quick check.",
    parameters: z.discriminatedUnion("action", [
      z.object({ action: z.literal("run"), request: z.string().trim().min(1).max(2000),
        commands: z.array(z.object({ command: z.string().trim().min(1).max(4000), cwd: z.string().max(400).default("."), timeoutSec: z.number().int().min(5).max(1800).default(300), expectExit: z.number().int().default(0) }).strict()).max(10).default([]) }).strict(),
      z.object({ action: z.literal("stop"), checkId: z.string().min(1) }).strict(),
    ]),
    execute: async (input, context) => {
      if (input.action === "stop") {
        const controller = running.get(input.checkId);
        controller?.abort(new Error("stopped by the PM"));
        return JSON.stringify({ checkId: input.checkId, stopped: Boolean(controller) });
      }
      const recipe = checkRecipe(input.request);
      if (recipe !== "quick") return JSON.stringify({ recipe, next: recipe === "full" ? "run the run-goal check of this run: every accepted task's checks together on main" : "use lane_pilot_helpers {action:\"browser_qa\"} with the page and the cases" });
      if (!input.commands.length) throw new ToolError("a quick check needs the commands to run", { code: "no_commands", retryable: false, sideEffects: "none" });
      const runId = await runOf(context);
      const run = runId ? getRun(db, runId) : undefined;
      const hostId = runId ? getRunWriterHost(db, runId) : null;
      if (!run?.writer_workspace_path || !hostId) throw new ToolError("this chat has no run with a checkout to check", { code: "no_checkout", retryable: false, sideEffects: "none" });
      const checkId = `chk_${Date.now().toString(36)}`;
      const controller = new AbortController();
      running.set(checkId, controller);
      const host = bb.hosts.experimental_client({ contract: hostContract });
      const measures: CheckMeasure[] = [];
      try {
        for (const item of input.commands) {
          if (controller.signal.aborted) break;
          const cwd = item.cwd === "." ? run.writer_workspace_path : `${run.writer_workspace_path}/${item.cwd.replace(/^\.?\//, "")}`;
          const result = await host.call("runSandboxedCommand", { requestedHostId: hostId, workspacePath: run.writer_workspace_path, cwd, command: item.command, timeoutSec: item.timeoutSec }, { hostId, timeoutMs: (item.timeoutSec + 30) * 1000 });
          const evidence = `${result.stdout}\n${result.stderr}`.trim().slice(-1500);
          measures.push({ command: item.command, cwd, expectExit: item.expectExit, timeoutSec: item.timeoutSec, evidence, exitCode: result.exitCode, passed: result.exitCode === item.expectExit });
        }
      } finally {
        running.delete(checkId);
      }
      return JSON.stringify({ checkId, recipe, stopped: controller.signal.aborted, passed: measures.every((row) => row.passed), measures });
    },
  });
}

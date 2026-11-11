import { z } from "zod";
import { callerPluginMetadata, registerObservedTool } from "../../platform/server";
import { ToolError, type ServerCore } from "../../contracts/server";
import { wayOut } from "../../contracts"
import { failureClass } from "../../contracts/failure-class";
import { getRun, getRunSettingsScopes, getRunWriterHost, listAttemptRowsForProject, listRunTaskSummaries, loadProjectSettings } from "../../storage";
import { checkRecipe, factKind, type CheckMeasure } from "../rails";
import { sha256Hex } from "@lane-pilot/kit";
import { sshKeysOpen, sshMaskEvidence } from "@lane-pilot/models";

/** A check as an operation (SMA m_ck_answer): one receipt per request hash. A request repeated while the check runs, or within
 *  half a minute of its end (a retried tool call), gets that receipt; later the same commands are a new check — the code may
 *  have been fixed in between, and an old red answer would hide it. */
type CheckReceipt = { checkId: string; requestHash: string; recipe: string; state: "running" | "passed" | "failed" | "stopped" | "stopped_by_turn_stop"; measures: CheckMeasure[]; startedAt: number; endedAt: number | null; stoppedCommand?: string | null };
const RECEIPT_GRACE_MS = 30_000;
const receiptKey = (runId: string, requestHash: string) => `chat-check:${runId}:${requestHash}`;
/** The same receipt under the check's own id, so `status` and `stop` find it without the request hash. */
const receiptIdKey = (checkId: string) => `chat-check-id:${checkId}`;

/**
 * The turn engine and the checks from the conversation (SMA map: Conversation and intake — One-turn engine, What kind of question,
 * Task status — the board, What ate the limit — arithmetic, Question about the past — books, Failure reason by dictionary; Checks from the
 * conversation — Whole request selects a recipe, Three check recipes, A check as an operation, Five required measures, Stop a check).
 * The PM asks code for the facts before it answers; the owner's «проверь …» runs as an operation with every measure on record.
 */
interface Services {
  spendByModel: (projectId: string, day: string) => Array<{ provider: string; model: string; tokens: number }>;
  /** The live phases of one PM thread with the stage's next action, for the «на каком этапе» question (SMA m_ce_classify). */
  phasesOf?: (pmThreadId: string) => Array<{ id: string; title: string; stage: string; state: string; next: string | null }>;
}

export function registerConversationTools(ctx: ServerCore, services: Services): void {
  const { db, bb, host } = ctx;
  /** A live check under its id: who can stop it and which thread's turn started it (SMA m_ck_stop / m_cd_stop). */
  const running = new Map<string, { controller: AbortController; threadId: string | null; stopReason: "stopped" | "stopped_by_turn_stop" }>();
  const byThread = new Map<string, Set<string>>();
  const forget = (checkId: string, threadId: string | null) => {
    running.delete(checkId);
    if (threadId) { const set = byThread.get(threadId); set?.delete(checkId); if (set && !set.size) byThread.delete(threadId); }
  };
  // A PM's turn stopped while its check ran (the reply was stopped, or the thread failed): the check's process tree ends
  // with it and the receipt says why — a reply's check never outlives the reply (SMA m_cd_stop).
  const threadOf = (payload: unknown) => {
    const thread = payload && typeof payload === "object" ? Reflect.get(payload, "thread") : undefined;
    const id = thread && typeof thread === "object" ? Reflect.get(thread, "id") : undefined;
    return typeof id === "string" ? id : null;
  };
  const stopThreadChecks = (payload: unknown) => {
    const threadId = threadOf(payload);
    if (!threadId) return;
    for (const checkId of byThread.get(threadId) ?? []) {
      const entry = running.get(checkId);
      if (entry) { entry.stopReason = "stopped_by_turn_stop"; entry.controller.abort(new Error("stopped_by_turn_stop")); }
    }
  };
  const events = (bb as unknown as { events?: { on?: (name: string, handler: (payload: unknown) => unknown) => void } }).events;
  if (events && typeof events.on === "function") {
    try {
      events.on("thread.idle", stopThreadChecks);
      events.on("thread.failed", stopThreadChecks);
    } catch (cause) { ctx.log(`chat check turn-stop listener failed: ${cause instanceof Error ? cause.message : String(cause)}`); }
  }

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
        const rows = listRunTaskSummaries(db, runId ?? "");
        const counts: Record<string, number> = {};
        for (const row of rows) counts[row.state ?? "queued"] = (counts[row.state ?? "queued"] ?? 0) + 1;
        return JSON.stringify({ kind, runId, counts, tasks: rows, sources: [`the run board (lane_pilot_attempt, run ${runId})`] });
      }
      if (kind === "limit") {
        const day = new Date().toISOString().slice(0, 10);
        const rows = services.spendByModel(context.projectId, day);
        return JSON.stringify({ kind, day, byModel: rows, sources: [`the spend book (lane_pilot_token_daily, ${day})`] });
      }
      if (kind === "history") {
        const rows = listAttemptRowsForProject(db, { projectId: context.projectId, states: ["accepted","blocked","canceled"], limit: 15 })
          .map((row) => ({ taskId: row.taskId, state: row.state, at: row.at }));
        return JSON.stringify({ kind, finished: rows.map((row) => ({ ...row, at: new Date(row.at).toISOString() })), sources: ["the finished attempts (lane_pilot_attempt)"] });
      }
      if (kind === "stage") {
        const phases = context.threadId && services.phasesOf ? services.phasesOf(context.threadId) : [];
        return JSON.stringify({ kind, phases, sources: ["lane_pilot_phase (the live phases of this PM thread)"] });
      }
      if (kind === "failure") {
        const rows = listAttemptRowsForProject(db, { projectId: context.projectId, states: ["validation_failed","blocked","provider_error","timeout","empty_output"], limit: 10 });
        return JSON.stringify({ kind, failures: rows.map((row) => ({ ...row, class: failureClass(row.state, row.reason), reason: (row.reason ?? "").slice(0, 300), next: wayOut(row.state, row.reason, row.failureCode) ?? undefined, at: new Date(row.at).toISOString() })), sources: ["the failed attempts and their failure class (lane_pilot_attempt)"] });
      }
      return JSON.stringify({ kind, facts: null, note: "no code answer for this kind of question: answer from your reading" });
    },
  });

  registerObservedTool(bb.agents, {
    name: "lane_pilot_check",
    description: "Run a check the owner asked for in the chat as an operation: the request selects the recipe (quick, full, browser) and every result carries its five measures.",
    instructions: "`run` (request: the owner's words; commands: for quick, the commands to run in the run's checkout, each with cwd relative to it and timeoutSec): quick runs them in the sandbox and returns per command the five measures — command, folder, expected exit, time limit, evidence (the output tail) — and passed. A request for the whole suite selects full: send the run's accepted tasks to the run-goal check (bb lane-pilot run-goal) instead; a request about a page selects browser: use lane_pilot_helpers {action:\"browser_qa\"}. `stop` stops this chat's running quick checks (or one by checkId) and `status` reads a receipt; a check also ends when its turn is stopped.",
    parameters: z.discriminatedUnion("action", [
      z.object({ action: z.literal("run"), request: z.string().trim().min(1).max(2000),
        commands: z.array(z.object({ command: z.string().trim().min(1).max(4000), cwd: z.string().max(400).default("."), timeoutSec: z.number().int().min(5).max(1800).default(300), expectExit: z.number().int().default(0) }).strict()).max(10).default([]) }).strict(),
      z.object({ action: z.literal("status"), checkId: z.string().min(1) }).strict(),
      z.object({ action: z.literal("stop"), checkId: z.string().min(1).optional() }).strict(),
    ]),
    execute: async (input, context) => {
      // The id is known only once the check ended, so a stop without it ends the checks this thread has running now.
      if (input.action === "stop" && !input.checkId) {
        const ids = [...(byThread.get(context.threadId ?? "") ?? [])];
        for (const id of ids) { const entry = running.get(id); if (entry) { entry.stopReason = "stopped"; entry.controller.abort(new Error("stopped by the PM")); } }
        return JSON.stringify({ stopped: ids.length > 0, checkIds: ids });
      }
      if (input.action === "status" || input.action === "stop") {
        const id = input.checkId!;
        if (input.action === "stop") {
          const entry = running.get(id);
          if (entry) { entry.stopReason = "stopped"; entry.controller.abort(new Error("stopped by the PM")); }
        }
        const receipt = await bb.storage.kv.get(receiptIdKey(id)).catch(() => null) as CheckReceipt | null;
        if (!receipt && input.action === "stop") return JSON.stringify({ checkId: id, stopped: false });
        if (!receipt) throw new ToolError("no check with this id", { code: "no_check", retryable: false, sideEffects: "none" });
        return JSON.stringify({ ...receipt, stopped: receipt.state === "stopped" || receipt.state === "stopped_by_turn_stop", running: running.has(id) });
      }
      const recipe = checkRecipe(input.request);
      if (recipe !== "quick") return JSON.stringify({ recipe, next: recipe === "full" ? "run the run-goal check of this run: every accepted task's checks together on main" : "use lane_pilot_helpers {action:\"browser_qa\"} with the page and the cases" });
      if (!input.commands?.length) throw new ToolError("a quick check needs the commands to run", { code: "no_commands", retryable: false, sideEffects: "none" });
      const runId = await runOf(context);
      const run = runId ? getRun(db, runId) : undefined;
      const hostId = runId ? getRunWriterHost(db, runId) : null;
      if (!run?.writer_workspace_path || !hostId) throw new ToolError("this chat has no run with a checkout to check", { code: "no_checkout", retryable: false, sideEffects: "none" });
      // The operation journal: the request hash is the key, the receipt the answer a repeated turn gets.
      const requestHash = sha256Hex(JSON.stringify({ runId, recipe, commands: input.commands }));
      const key = receiptKey(runId!, requestHash);
      const kv = bb.storage.kv;
      const stored = await kv.get(key).catch(() => null) as CheckReceipt | null;
      // A receipt still «running» past its commands' own time limits was left by a restart, not by a live check.
      const runLimitMs = (input.commands.reduce((sum, item) => sum + item.timeoutSec + 30, 0) + 60) * 1000;
      const live = stored?.state === "running" && Date.now() - stored.startedAt < runLimitMs;
      if (stored && (live || (stored.endedAt !== null && Date.now() - stored.endedAt < RECEIPT_GRACE_MS))) {
        return JSON.stringify({ ...stored, deduplicated: true });
      }
      const workspacePath = run.writer_workspace_path;
      // verification.ssh_keys (project, unset = off): ~/.ssh is masked in checks unless the project says on.
      const sshKeys = sshKeysOpen(loadProjectSettings(db, run.project_id, getRunSettingsScopes(db, runId!)));
      const checkId = `chk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const receipt: CheckReceipt = { checkId, requestHash, recipe, state: "running", measures: [], startedAt: Date.now(), endedAt: null };
      const writeReceipt = async () => {
        await kv.set(key, receipt as never).catch(() => undefined);
        await kv.set(receiptIdKey(checkId), receipt as never).catch(() => undefined);
      };
      await writeReceipt();
      const entry = { controller: new AbortController(), threadId: context.threadId ?? null, stopReason: "stopped" as "stopped" | "stopped_by_turn_stop" };
      running.set(checkId, entry);
      if (entry.threadId) byThread.set(entry.threadId, new Set([...(byThread.get(entry.threadId) ?? []), checkId]));
      // The stopped turn cancels its own tool call: the same stop, without waiting for the thread event.
      context.signal?.addEventListener("abort", () => { if (running.has(checkId)) { entry.stopReason = "stopped_by_turn_stop"; entry.controller.abort(new Error("stopped_by_turn_stop")); } }, { once: true });
      // The commands run as host jobs so a stop reaches their process tree (SMA m_ck_stop): `stop` by id from another
      // call, or the end of the turn that started the check. The call itself waits and answers with the receipt — a PM
      // cannot sleep, so a check it had to poll would either burn turns or die with the turn that went to wait for it.
      const commands = input.commands;
      await (async () => {
        let current: string | null = null;
        try {
          for (const [index, item] of commands.entries()) {
            if (entry.controller.signal.aborted) break;
            const cwdIn = item.cwd ?? ".", timeoutSec = item.timeoutSec ?? 300, expectExit = item.expectExit ?? 0;
            const cwd = cwdIn === "." ? workspacePath : `${workspacePath}/${cwdIn.replace(/^\.?\//, "")}`;
            current = item.command;
            try {
              const result = await host.call("runSandboxedCommand", { requestedHostId: hostId, workspacePath, cwd, command: item.command, timeoutSec, protectedRoots: true, ...(sshKeys ? { sshKeys: true } : {}) },
                { hostId, timeoutMs: (timeoutSec + 30) * 1000, job: true, jobKey: `${checkId}:${index}`, signal: entry.controller.signal, cancelOnAbort: true });
              // The run's writer workspace is a live checkout: a change of its protected roots is recorded, never a failure.
              receipt.measures.push(checkMeasureOf({ command: item.command, cwd, expectExit, timeoutSec, result, throwaway: false, projectId: run.project_id }));
            } catch (cause) {
              if (entry.controller.signal.aborted) break;
              receipt.measures.push({ command: item.command, cwd, expectExit, timeoutSec,
                evidence: (cause instanceof Error ? cause.message : String(cause)).slice(0, 1500), exitCode: -1, passed: false });
            }
          }
        } finally {
          forget(checkId, entry.threadId);
          receipt.endedAt = Date.now();
          const stopped = entry.controller.signal.aborted;
          receipt.stoppedCommand = stopped ? current : null;
          receipt.state = stopped ? entry.stopReason : receipt.measures.every((row) => row.passed) ? "passed" : "failed";
          await writeReceipt();
        }
      })().catch((cause: unknown) => ctx.log(`chat check ${checkId} failed to finish: ${cause instanceof Error ? cause.message : String(cause)}`));
      return JSON.stringify({ ...receipt, stopped: receipt.state === "stopped" || receipt.state === "stopped_by_turn_stop", passed: receipt.state === "passed" });
    },
  });
}

/**
 * One check measure from a sandboxed run (SMA m_ck_required): the command's record plus the sandbox's own
 * measures — cleared environment, closed publication, the protected-roots manifest. A changed .git/.agents/.cls fails
 * the measure only when the command ran in a throwaway copy (`throwaway: true`); in a live checkout (the writer
 * workspace, the PM checkout) other work legitimately touches those roots, so the change is recorded as
 * `rootsChanged: true` with a note and never fails the measure.
 */
export function checkMeasureOf(input: {
  command: string; cwd: string; expectExit: number; timeoutSec: number; throwaway?: boolean; projectId?: string;
  result: { exitCode: number; stdout: string; stderr: string; backend?: string; policySha256?: string; maskedSsh?: boolean;
    rootsManifest?: { before: string; after: string; changed: boolean; partial?: boolean; git?: string } };
}): CheckMeasure {
  const manifest = input.result.rootsManifest;
  const rootsChanged = manifest?.changed === true && manifest.partial !== true;
  const fails = rootsChanged && input.throwaway === true;
  const note = rootsChanged ? (fails ? "\nprotected roots (.git/.agents/.cls) changed during the check"
    : "\nprotected roots (.git/.agents/.cls) changed during the check (live checkout: recorded, not a failure)") : "";
  const ssh = input.projectId ? sshMaskEvidence({ projectId: input.projectId, exitCode: input.result.exitCode, output: `${input.result.stdout}\n${input.result.stderr}`, masked: input.result.maskedSsh }) : null;
  const evidence = `${input.result.stdout}\n${input.result.stderr}`.trim().slice(-1500) + note + (ssh ? `\n${ssh}` : "");
  return { command: input.command, cwd: input.cwd, expectExit: input.expectExit, timeoutSec: input.timeoutSec,
    evidence, exitCode: input.result.exitCode, passed: input.result.exitCode === input.expectExit && !fails,
    backend: input.result.backend, policySha256: input.result.policySha256, env: "cleared", publication: "closed",
    rootsSha256: manifest?.after, rootsChanged,
    ...(manifest?.partial ? { rootsPartial: true } : {}), ...(manifest?.git ? { rootsGit: manifest.git } : {}) };
}

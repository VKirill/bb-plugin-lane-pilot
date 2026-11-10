import { z } from "zod";
import { callerPluginMetadata, registerObservedTool } from "../../platform/server";
import { ToolError, type ServerCore } from "../../contracts/server";
import { hostContract } from "../../contracts";
import { wayOut } from "../../contracts"
import { failureClass } from "../../contracts/failure-class";
import { getRun, getRunWriterHost, listAttemptRowsForProject, listRunTaskSummaries } from "../../storage";
import { checkRecipe, factKind, type CheckMeasure } from "../rails";
import { sha256Hex } from "@lane-pilot/kit";

/** A check as an operation (SMA m_ck_answer): one receipt per request hash. A request repeated while the check runs, or within
 *  half a minute of its end (a retried tool call), gets that receipt; later the same commands are a new check — the code may
 *  have been fixed in between, and an old red answer would hide it. */
/** The five protections a check result reports (SMA m_ck_required): the recipe from the pinned snapshot, the throwaway
 *  copy it ran in, the clean environment without ambient secrets, the closed publication (HOME is the sandbox temp dir,
 *  so no git or npm credentials publish), and the protected-roots manifest taken before and after. */
type CheckProtections = {
  recipeSource: string | null;
  copyPath: string | null;
  cleanEnv: { backend: string; policySha256: string; secrets: boolean } | null;
  publication: "closed";
  manifest: { before: string | null; after: string | null };
};
type CheckReceipt = { checkId: string; requestHash: string; recipe: string; state: "running" | "passed" | "failed" | "stopped"; measures: CheckMeasure[]; protections?: CheckProtections; reason?: string; startedAt: number; endedAt: number | null };
const RECEIPT_GRACE_MS = 30_000;
const receiptKey = (runId: string, requestHash: string) => `chat-check:${runId}:${requestHash}`;

/** Which protection is absent; the check's reason names it. A different manifest before and after is `roots_changed`. */
function missingProtections(protections: CheckProtections): string[] {
  const missing: string[] = [];
  if (!protections.recipeSource) missing.push("recipe");
  if (!protections.copyPath) missing.push("copy");
  if (!protections.cleanEnv) missing.push("cleanEnv");
  if (protections.manifest.before === null || protections.manifest.after === null) missing.push("manifest");
  else if (protections.manifest.before !== protections.manifest.after) return ["roots_changed"];
  return missing;
}

/** The package manager the copy's lockfile names (SMA m_ck_recipes): the recipe is the project's own declared one. */
export function packageManagerOf(files: readonly string[]): "pnpm" | "yarn" | "bun" | "npm" {
  if (files.includes("pnpm-lock.yaml")) return "pnpm";
  if (files.includes("yarn.lock")) return "yarn";
  if (files.some((file) => /^bun\.lockb?$/.test(file))) return "bun";
  return "npm";
}

/** The quick recipe from the copy's package.json at its baseSha: scripts.test through the lockfile's package manager. */
export function pinnedRecipe(packageJsonText: string, lockfiles: readonly string[], baseSha: string | null): { command: string; recipeSource: string } | null {
  let scripts: Record<string, unknown> | undefined;
  try { scripts = (JSON.parse(packageJsonText) as { scripts?: Record<string, unknown> }).scripts; } catch { return null; }
  const test = scripts?.test;
  if (typeof test !== "string" || !test.trim()) return null;
  return { command: `${packageManagerOf(lockfiles)} run test`, recipeSource: `package.json@${baseSha ?? "HEAD"}` };
}

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
      const checkId = `chk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const receipt: CheckReceipt = { checkId, requestHash, recipe, state: "running", measures: [], startedAt: Date.now(), endedAt: null };
      await kv.set(key, receipt as never).catch(() => undefined);
      const controller = new AbortController();
      running.set(checkId, controller);
      const host = bb.hosts.experimental_client({ contract: hostContract });
      const base = run.writer_workspace_path;
      const hostCall = (method: string, callInput: Record<string, unknown>, timeoutMs = 60_000) =>
        host.call(method as never, { requestedHostId: hostId, ...callInput } as never, { hostId, timeoutMs }) as Promise<any>;
      // The protected-roots manifest (SMA m_ck_isolated): the checkout's head and the hash of its porcelain status,
      // taken before and after the run — a check that moved either changed the project it was not allowed to touch.
      const manifestOf = async () => {
        const result = await hostCall("runCommand", { cwd: base, command: "git rev-parse HEAD && git status --porcelain", timeoutSec: 30 }, 45_000);
        const [head, ...rest] = String(result.stdout ?? "").trimEnd().split("\n");
        return `${head ?? ""}:${sha256Hex(rest.join("\n"))}`;
      };
      // The throwaway copy the check runs in; its commands write there, never the run's checkout.
      const copy = await hostCall("gitCreateWorktree", { basePath: base, name: checkId }, 120_000).catch((cause: unknown) => ({ status: "failed", path: null, reason: cause instanceof Error ? cause.message : String(cause) }));
      const copyPath: string | null = copy.status === "ready" && typeof copy.path === "string" ? copy.path : null;
      const protections: CheckProtections = { recipeSource: null, copyPath, cleanEnv: null, publication: "closed", manifest: { before: null, after: null } };
      try {
        protections.manifest.before = await manifestOf().catch(() => null);
        // The recipe is the project's own: scripts.test of the copy's package.json at its baseSha, run through the
        // package manager its lockfile names. The PM's commands are taken only when package.json has no test script.
        let commands = input.commands;
        if (copyPath) {
          const listing = await hostCall("runCommand", { cwd: copyPath, command: `ls pnpm-lock.yaml yarn.lock package-lock.json bun.lockb bun.lock 2>/dev/null; echo "---PKG---"; cat package.json`, timeoutSec: 30 }, 45_000).catch(() => null);
          if (listing) {
            const [locks, pkg] = String(listing.stdout ?? "").split("---PKG---\n", 2);
            const pinned = pinnedRecipe(pkg ?? "", (locks ?? "").split("\n").map((line) => line.trim()).filter(Boolean), copy.baseSha ?? null);
            if (pinned) {
              commands = [{ command: pinned.command, cwd: ".", timeoutSec: Math.max(...input.commands.map((item) => item.timeoutSec)), expectExit: 0 }];
              protections.recipeSource = pinned.recipeSource;
            } else protections.recipeSource = "pm";
          }
        }
        for (const item of commands) {
          if (controller.signal.aborted || !copyPath) break;
          const cwd = item.cwd === "." ? copyPath : `${copyPath}/${item.cwd.replace(/^\.?\//, "")}`;
          const result = await hostCall("runSandboxedCommand", { workspacePath: copyPath, cwd, command: item.command, timeoutSec: item.timeoutSec }, (item.timeoutSec + 30) * 1000);
          // The clean environment the command saw: its backend and policy hash; no ambient secrets are passed.
          if (!protections.cleanEnv) protections.cleanEnv = { backend: String(result.backend ?? ""), policySha256: String(result.policySha256 ?? ""), secrets: false };
          const evidence = `${result.stdout}\n${result.stderr}`.trim().slice(-1500);
          receipt.measures.push({ command: item.command, cwd, expectExit: item.expectExit, timeoutSec: item.timeoutSec, evidence, exitCode: result.exitCode, passed: result.exitCode === item.expectExit });
        }
        protections.manifest.after = await manifestOf().catch(() => null);
      } finally {
        running.delete(checkId);
        if (copyPath) await hostCall("gitRemoveWorktree", { basePath: base, worktreePath: copyPath }, 60_000).catch(() => undefined);
        const missing = missingProtections(protections);
        receipt.protections = protections;
        receipt.endedAt = Date.now();
        receipt.state = controller.signal.aborted ? "stopped" : missing.length ? "failed" : receipt.measures.every((row) => row.passed) ? "passed" : "failed";
        if (missing.length) receipt.reason = missing.includes("roots_changed") ? "roots_changed: the check's copy run changed the run checkout's protected roots" : `protection missing: ${missing.join(", ")}`;
        await kv.set(key, receipt as never).catch(() => undefined);
      }
      return JSON.stringify({ ...receipt, stopped: controller.signal.aborted, passed: receipt.state === "passed" });
    },
  });
}

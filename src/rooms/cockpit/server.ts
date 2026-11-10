import { hostContract, rpcContract } from "../contracts";

import type { ServerCore } from "../contracts/server";
import { activeRunForProject, getRun, getTaskContractJson, listAttemptRowsForProject, setTaskHeldUntil, taskHeldUntil, updateTaskContractJson } from "../storage";
import { attemptRecord } from "../tools/server";
import { listReceipts } from "../capability";
import { tokenDailySeries, tokenDailyTotal } from "../usage/server";
import { readTaskApproach } from "../tasks";
import { designJournalLines, readinessWords, trainedConditions, trainingRatios } from "../design-eval";
import { runOnHost } from "@lane-pilot/host-calls";
import { listPhasePartsSince } from "../phase";
import { activeMemoryDigestRows, countActiveMemory, lintMemory, memoryWithoutTrace, rebuildMemoryIndexes, reviewMemory } from "@lane-pilot/memory-core";
import { currentEmbedder, embedPending, memorySettingsFor } from "../memory/server";
import { loadProjectSettings } from "../storage";

import type { FrontApi } from "../front/server/index";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  front: FrontApi;
}

const SEEN = "lp.cockpit.seen";
const FAULTS = "lp.cockpit.faults";
const DAY_MS = 86_400_000;

/**
 * The reads and the few actions of the window's cockpit (src/rooms/cockpit/ui): Today, workers and lanes, the memory corpus on the machine,
 * the forge order a person places, the designer's training, the subscription windows, how long a screen was looked at, a fault a person
 * reports. Everything else the screens show comes from the RPCs that already exist (phases, front, money, owner waiting).
 */
export function cockpitRpc(ctx: ServerCore, services: Services) {
  const { db, bb } = ctx;
  const kv = bb.storage.kv;
  const host = () => bb.hosts.experimental_client({ contract: hostContract });
  const activeRun = (projectId: string) => activeRunForProject(db, projectId);

  return {
    /** Today: the day's KPI strip and its feed (accepted, blocked, phase parts, actions). */
    cockpit_today: async ({ projectId }: { projectId: string }) => {
      const since = Date.now() - DAY_MS;
      const rows = listAttemptRowsForProject(db, { projectId, updatedSince: since, limit: 300 });
      const tokens = tokenDailyTotal(db, projectId, new Date().toISOString().slice(0, 10));
      const parts = listPhasePartsSince(db, projectId, since);
      const actions = (await services.front.actions(200)).filter((row) => (row as { at: number }).at >= since);
      return {
        kpi: { accepted: rows.filter((row) => row.state === "accepted").length, blocked: rows.filter((row) => row.state === "blocked").length, running: rows.filter((row) => row.state === "running").length, tokens, actions: actions.length },
        feed: [...rows.map((row) => ({ at: row.at, kind: `task_${row.state}`, text: `${row.taskId}${row.reason ? ` — ${row.reason.slice(0, 160)}` : ""}` })),
          ...parts.map((part) => ({ at: part.at as number, kind: `phase_${part.kind}`, text: `${part.phaseId}: ${String(part.text).slice(0, 200)}` }))].sort((a, b) => b.at - a.at).slice(0, 150),
      };
    },
    /** Workers over 30 days (tokens by provider and model) with their capability cells: the worker cards and their history. */
    cockpit_workers: async ({ projectId }: { projectId: string }) => {
      const since = new Date(Date.now() - 30 * DAY_MS).toISOString().slice(0, 10);
      const usage = tokenDailySeries(db, projectId, since);
      const cells = listReceipts(db);
      const byWorker = new Map<string, { providerId: string; model: string; tokens: number; days: Array<{ day: string; tokens: number }> }>();
      for (const row of usage) {
        const key = `${row.providerId}/${row.model}`;
        const worker = byWorker.get(key) ?? { providerId: row.providerId, model: row.model, tokens: 0, days: [] };
        worker.tokens += row.tokens; worker.days.push({ day: row.day, tokens: row.tokens }); byWorker.set(key, worker);
      }
      return [...byWorker.values()].sort((a, b) => b.tokens - a.tokens).map((worker) => ({ ...worker, capabilities: cells.filter((cell) => cell.providerId === worker.providerId).map((cell) => ({ capability: cell.capability, state: cell.state, version: cell.version })) }));
    },
    /** Hub memory for this run's project. (2026-10-29) the terminal lane-memory tool is not called. */
    cockpit_memory: async ({ runId, action }: { runId: string; action: "lint" | "index" | "tags" | "consolidate" }) => {
      const run = getRun(db, runId);
      if (!run) throw new Error(`run ${runId} has no checkout`);
      const rows = activeMemoryDigestRows(db, run.project_id);
      if (action === "index") {
        // The derived word indexes are rebuilt from the active records; vectors catch up through the shared embedder.
        const done = rebuildMemoryIndexes(db, run.project_id);
        const embedder = currentEmbedder();
        const embedded = embedder ? await embedPending(db, embedder).catch(() => 0) : 0;
        return { exitCode: 0, output: `Перестроено записей: ${done.active}${done.added || done.stale ? ` (добавлено ${done.added}, убрано ${done.stale})` : ""}${embedded ? `\nВекторов обновлено: ${embedded}` : ""}` };
      }
      if (action === "lint") {
        const findings = lintMemory(db, run.project_id, { budgets: memorySettingsFor(loadProjectSettings(db, run.project_id)) });
        // The corpus listing the lint button always showed stays under the findings.
        const corpus = rows.map((row) => `[${row.kind}] ${row.content}`);
        if (!findings.length) return { exitCode: 0, output: ["Все записи привязаны к задаче или файлу", ...corpus].join("\n").slice(0, 20_000) };
        // N and M are counted on the whole project (the digest is capped at 80); N is the one definition the lint uses.
        const lines = [`Без следа в работе: ${memoryWithoutTrace(db, run.project_id).length} из ${countActiveMemory(db, run.project_id)}`];
        for (const item of findings) lines.push(`[${item.tier}] ${item.check}${item.recordId ? ` ${item.recordId.slice(0, 12)}` : ""} ${item.detail}`);
        return { exitCode: 0, output: [...lines, "", ...corpus].join("\n").slice(0, 20_000) };
      }
      if (action === "consolidate") {
        const proposals = reviewMemory(db, run.project_id);
        return { exitCode: 0, output: proposals.length ? proposals.map((item) => `${item.action} ${item.id.slice(0, 12)}${item.by ? ` ← ${item.by.slice(0, 12)}` : ""}${item.reason ? ` (${item.reason})` : ""}`).join("\n") : "Предложений нет: корпус в порядке" };
      }
      if (action === "tags") {
        const counts = new Map<string, number>();
        for (const row of rows) for (const tag of JSON.parse(row.concepts_json || "[]") as string[]) counts.set(tag, (counts.get(tag) ?? 0) + 1);
        const tags = [...counts].map(([tag, count]) => ({ tag, count }));
        return { exitCode: 0, output: tags.map((item) => `${item.tag} (${item.count})`).join("\n").slice(0, 20_000), tags };
      }
      return { exitCode: 0, output: rows.map((row) => `[${row.kind}] ${row.content}`).join("\n").slice(0, 20_000) };
    },
    /** Order from the forge: the person's order goes to the project's PM, who runs lane_pilot_forge draft with it. */
    cockpit_forge_order: async ({ projectId, kind, name, brief }: { projectId: string; kind: "skill" | "role" | "workflow"; name: string; brief: string }) => {
      const run = activeRun(projectId);
      if (!run?.pm_thread_id) throw new Error("no Lane Pilot PM chat is open in this project: enable Lane Pilot in a chat first");
      await bb.sdk.threads.send({ threadId: run.pm_thread_id, mode: "queue-if-active", input: [{ type: "text", mentions: [], text: `[Lane Pilot window] The owner orders from the forge: a ${kind} «${name}». Run lane_pilot_forge {action:"draft", kind:"${kind}", name:"${name}", brief} with this brief: ${brief}` }] } as never);
      return { ordered: true, pmThreadId: run.pm_thread_id };
    },
    /** The designer's statistics: ratios, the conditions of «trained», the readiness words. */
    cockpit_designer: async ({ projectId }: { projectId?: string }) => {
      const all = await designJournalLines(kv);
      const lines = projectId ? all.filter((line) => line.projectId === projectId) : all;
      return { ratios: trainingRatios(lines), conditions: trainedConditions(lines), readiness: readinessWords(lines), recent: lines.slice(-20).reverse() };
    },
    /** Subscription window bars: the five-hour and seven-day windows the machine last saw. */
    cockpit_windows: async ({ hostId }: { hostId: string }) => host().call("readUsageWindows", { requestedHostId: hostId }, { hostId, timeoutMs: 5_000 }),
    /** Time the card was visible: how long a screen stayed in view, for the screens nobody opens. */
    cockpit_seen: async ({ screen, ms }: { screen: string; ms: number }) => {
      const seen = ((await kv.get(SEEN)) as Record<string, { views: number; ms: number; last: number }> | null) ?? {};
      const row = seen[screen] ?? { views: 0, ms: 0, last: 0 };
      seen[screen] = { views: row.views + 1, ms: row.ms + Math.min(ms, 3_600_000), last: Date.now() };
      await kv.set(SEEN, seen as never);
      return { ok: true as const };
    },
    /** The screens' view counts, and the contract's RPC names for the «reads no screen calls» check. */
    cockpit_seen_list: async () => ({ seen: ((await kv.get(SEEN)) as Record<string, unknown> | null) ?? {}, rpcs: Object.keys(rpcContract) }),
    /** New task form, new batch form, promote a backlog item, ship: the person's request goes to the project's PM, who runs it with its tools. */
    cockpit_request: async ({ projectId, kind, text }: { projectId: string; kind: "task" | "batch" | "promote" | "ship"; text: string }) => {
      const run = activeRun(projectId);
      if (!run?.pm_thread_id) throw new Error("no Lane Pilot PM chat is open in this project: enable Lane Pilot in a chat first");
      const lead = kind === "task" ? "a new task" : kind === "batch" ? "a new batch of tasks (one per line)" : kind === "promote" ? "to promote a backlog item to a task" : "to ship";
      await bb.sdk.threads.send({ threadId: run.pm_thread_id, mode: "queue-if-active", input: [{ type: "text", mentions: [], text: `[Lane Pilot window] The owner asks for ${lead}:\n${text}` }] } as never);
      return { sent: true, pmThreadId: run.pm_thread_id };
    },
    /** Move queue position: a task held, released, or given another priority (the order queued tasks start in). */
    cockpit_queue: async ({ runId, taskIds, action, priority }: { runId: string; taskIds: string[]; action: "hold" | "release" | "priority"; priority?: string }) => {
      const changed: string[] = [];
      // A hold or a priority is reported only for a task of this run (SMA bi_pause): a task of another run is refused, not silently counted.
      const refused: Array<{ taskId: string; why: string }> = [];
      for (const taskId of taskIds) {
        const matched = action === "priority"
          ? (() => { const stored = getTaskContractJson(db, taskId, runId);
              if (stored) updateTaskContractJson(db, taskId, runId, JSON.stringify({ ...(JSON.parse(stored) as Record<string, unknown>), priority: priority ?? "normal" }));
              return Boolean(stored); })()
          : setTaskHeldUntil(db, taskId, runId, action === "hold" ? Date.UTC(2999, 0, 1) : null);
        if (matched) changed.push(taskId); else refused.push({ taskId, why: `not a task of run ${runId}` });
      }
      return { changed, refused };
    },
    /** Run update: the Lane Stack update report on a machine, applied with apply. */
    cockpit_update: async ({ hostId, apply }: { hostId: string; apply: boolean }) => {
      const ran = await runOnHost(host(), { hostId, cwd: "/tmp", command: `lane-stack-update --json${apply ? " --yes" : ""}`, timeoutSec: apply ? 600 : 60 });
      return { exitCode: ran.exitCode, output: (ran.stdout || ran.stderr).slice(0, 20_000) };
    },
    /** One attempt's whole record in one answer (SMA ap_run_dir): writer thread, stage receipts, gate events, dispatch context, verification, critic hash, attempt-change. */
    cockpit_attempt: async ({ attemptId }: { attemptId: string }) => attemptRecord(db, attemptId),
    /** A task for the window: its clarification, drawing, priority and hold from the contract, and the writer's approach note. */
    cockpit_task: async ({ runId, taskId }: { runId: string; taskId: string }) => {
      const stored = getTaskContractJson(db, taskId, runId);
      if (!stored) return null;
      const contract = JSON.parse(stored) as { display_title?: string; clarify?: unknown; drawing?: string[]; priority?: string; area?: string; objective?: string };
      return { displayTitle: contract.display_title ?? null, objective: contract.objective ?? null, area: contract.area ?? null, clarify: contract.clarify ?? null, drawing: contract.drawing ?? [],
        priority: contract.priority ?? "normal", heldUntil: taskHeldUntil(db, taskId), approach: await readTaskApproach(kv, runId, taskId) };
    },
    /** Report a fault: what a person saw goes to the self-repair queue with the screen it was on. */
    cockpit_fault: async ({ screen, text }: { screen: string; text: string }) => {
      const faults = ((await kv.get(FAULTS)) as Array<{ at: number; screen: string; text: string }> | null) ?? [];
      await kv.set(FAULTS, [...faults, { at: Date.now(), screen, text: text.slice(0, 2000) }].slice(-200) as never);
      ctx.log(`fault reported from the window (${screen}): ${text.slice(0, 300)}`);
      return { ok: true as const };
    },
  };
}

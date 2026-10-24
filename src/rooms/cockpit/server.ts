import { hostContract, rpcContract } from "../contracts";
import type { ServerCore, Services } from "../core/server";
import { getRun, getRunWriterHost } from "../storage";
import { listReceipts } from "../capability";
import { readinessWords, trainedConditions, trainingRatios, type DesignJournalLine } from "../design-eval";
import { runOnHost } from "@lane-pilot/host-calls";

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
  const activeRun = (projectId: string) => db.prepare("SELECT id, pm_thread_id FROM lane_pilot_run WHERE project_id=? AND state IN ('pending','running') ORDER BY created_at DESC LIMIT 1").get(projectId) as { id: string; pm_thread_id: string | null } | undefined;

  return {
    /** Today: the day's KPI strip and its feed (accepted, blocked, phase parts, actions). */
    cockpit_today: async ({ projectId }: { projectId: string }) => {
      const since = Date.now() - DAY_MS;
      const rows = db.prepare("SELECT a.task_id AS taskId, a.state, a.updated_at AS at, a.reason FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id WHERE r.project_id=? AND a.updated_at>=? ORDER BY a.updated_at DESC LIMIT 300").all(projectId, since) as Array<{ taskId: string; state: string; at: number; reason: string | null }>;
      const tokens = (db.prepare("SELECT COALESCE(SUM(total_tokens),0) AS n FROM lane_pilot_token_daily WHERE project_id=? AND day=?").get(projectId, new Date().toISOString().slice(0, 10)) as { n: number }).n;
      const parts = db.prepare("SELECT p.phase_id AS phaseId, p.section, p.kind, p.text, p.at FROM lane_pilot_phase_part p JOIN lane_pilot_phase f ON f.id=p.phase_id WHERE f.project_id=? AND p.at>=? ORDER BY p.at DESC LIMIT 100").all(projectId, since) as Array<Record<string, unknown>>;
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
      const usage = db.prepare("SELECT provider_id AS providerId, model, day, SUM(total_tokens) AS tokens FROM lane_pilot_token_daily WHERE project_id=? AND day>=? GROUP BY provider_id, model, day ORDER BY day").all(projectId, since) as Array<{ providerId: string; model: string; day: string; tokens: number }>;
      const cells = listReceipts(db);
      const byWorker = new Map<string, { providerId: string; model: string; tokens: number; days: Array<{ day: string; tokens: number }> }>();
      for (const row of usage) {
        const key = `${row.providerId}/${row.model}`;
        const worker = byWorker.get(key) ?? { providerId: row.providerId, model: row.model, tokens: 0, days: [] };
        worker.tokens += row.tokens; worker.days.push({ day: row.day, tokens: row.tokens }); byWorker.set(key, worker);
      }
      return [...byWorker.values()].sort((a, b) => b.tokens - a.tokens).map((worker) => ({ ...worker, capabilities: cells.filter((cell) => cell.providerId === worker.providerId).map((cell) => ({ capability: cell.capability, state: cell.state, version: cell.version })) }));
    },
    /** The memory corpus on the run's machine: lint, rebuild the index, the tag cloud, the corpus review. */
    cockpit_memory: async ({ runId, action }: { runId: string; action: "lint" | "index" | "tags" | "consolidate" }) => {
      const run = getRun(db, runId);
      const hostId = getRunWriterHost(db, runId);
      if (!run?.writer_workspace_path || !hostId) throw new Error(`run ${runId} has no checkout`);
      const command = action === "tags" ? "cat .agents/memory/TAGS.md 2>/dev/null || lane-memory index ." : `lane-memory ${action} .`;
      const ran = await runOnHost(host(), { hostId, cwd: run.writer_workspace_path, command, timeoutSec: 60 });
      const text = ran.stdout || ran.stderr;
      const tags = action === "tags" ? [...text.matchAll(/^[-*]\s*`?([A-Za-z0-9:_./-]+)`?(?:\s*\((\d+)\))?/gm)].map((m) => ({ tag: m[1]!, count: Number(m[2] ?? 1) })) : undefined;
      return { exitCode: ran.exitCode, output: text.slice(0, 20_000), ...(tags ? { tags } : {}) };
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
      const all = ((await kv.get("lp.design.journal").catch(() => null)) as DesignJournalLine[] | null) ?? [];
      const lines = projectId ? all.filter((line) => line.projectId === projectId) : all;
      return { ratios: trainingRatios(lines), conditions: trainedConditions(lines), readiness: readinessWords(lines), recent: lines.slice(-20).reverse() };
    },
    /** Subscription window bars: the five-hour and seven-day windows the machine last saw. */
    cockpit_windows: async ({ hostId }: { hostId: string }) => host().call("readUsageWindows", { requestedHostId: hostId }, { hostId, timeoutMs: 5_000 }),
    /** Time the card was visible: how long a screen stayed in view, for the screens nobody opens. */
    cockpit_seen: async ({ screen, ms }: { screen: string; ms: number }) => {
      const seen = ((await kv.get(SEEN).catch(() => null)) as Record<string, { views: number; ms: number; last: number }> | null) ?? {};
      const row = seen[screen] ?? { views: 0, ms: 0, last: 0 };
      seen[screen] = { views: row.views + 1, ms: row.ms + Math.min(ms, 3_600_000), last: Date.now() };
      await kv.set(SEEN, seen as never);
      return { ok: true as const };
    },
    /** The screens' view counts, and the contract's RPC names for the «reads no screen calls» check. */
    cockpit_seen_list: async () => ({ seen: ((await kv.get(SEEN).catch(() => null)) as Record<string, unknown> | null) ?? {}, rpcs: Object.keys(rpcContract) }),
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
      for (const taskId of taskIds) {
        if (action === "priority") {
          const row = db.prepare("SELECT contract_json AS contract FROM lane_pilot_task WHERE id=? AND run_id=?").get(taskId, runId) as { contract?: string } | undefined;
          if (!row?.contract) continue;
          const contract = { ...(JSON.parse(row.contract) as Record<string, unknown>), priority: priority ?? "normal" };
          db.prepare("UPDATE lane_pilot_task SET contract_json=? WHERE id=? AND run_id=?").run(JSON.stringify(contract), taskId, runId);
        } else db.prepare("UPDATE lane_pilot_task SET held_until=? WHERE id=? AND run_id=?").run(action === "hold" ? Date.UTC(2999, 0, 1) : null, taskId, runId);
        changed.push(taskId);
      }
      return { changed };
    },
    /** Run update: the Lane Stack update report on a machine, applied with apply. */
    cockpit_update: async ({ hostId, apply }: { hostId: string; apply: boolean }) => {
      const ran = await runOnHost(host(), { hostId, cwd: "/tmp", command: `lane-stack-update --json${apply ? " --yes" : ""}`, timeoutSec: apply ? 600 : 60 });
      return { exitCode: ran.exitCode, output: (ran.stdout || ran.stderr).slice(0, 20_000) };
    },
    /** A task for the window: its clarification, drawing, priority and hold from the contract, and the writer's approach note. */
    cockpit_task: async ({ runId, taskId }: { runId: string; taskId: string }) => {
      const row = db.prepare("SELECT contract_json AS contract, held_until AS heldUntil FROM lane_pilot_task WHERE id=? AND run_id=?").get(taskId, runId) as { contract?: string; heldUntil?: number | null } | undefined;
      if (!row?.contract) return null;
      const contract = JSON.parse(row.contract) as { display_title?: string; clarify?: unknown; drawing?: string[]; priority?: string; area?: string; objective?: string };
      return { displayTitle: contract.display_title ?? null, objective: contract.objective ?? null, area: contract.area ?? null, clarify: contract.clarify ?? null, drawing: contract.drawing ?? [],
        priority: contract.priority ?? "normal", heldUntil: row.heldUntil ?? null, approach: await kv.get(`lp.task.approach:${runId}:${taskId}`).catch(() => null) };
    },
    /** Report a fault: what a person saw goes to the self-repair queue with the screen it was on. */
    cockpit_fault: async ({ screen, text }: { screen: string; text: string }) => {
      const faults = ((await kv.get(FAULTS).catch(() => null)) as Array<{ at: number; screen: string; text: string }> | null) ?? [];
      await kv.set(FAULTS, [...faults, { at: Date.now(), screen, text: text.slice(0, 2000) }].slice(-200) as never);
      ctx.log(`fault reported from the window (${screen}): ${text.slice(0, 300)}`);
      return { ok: true as const };
    },
  };
}

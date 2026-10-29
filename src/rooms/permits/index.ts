import { z } from "zod";
import { ToolError, registerObservedTool, scheduleIsolated, type ServerCore } from "../core/server";
import { hostContract } from "../contracts";
import { getAttempt, getRun, getRunWriterHost, listOpenAttempts } from "../storage";

/**
 * Permits (SMA map: Permission before an act, Permit channel for the worker, Permit channel opened, Ticket awaits a decision, Approve or deny
 * the call, Ticket decision form). A writer whose command the guard would refuse (deleting for good, DROP/TRUNCATE) files a ticket on its
 * machine instead of only being refused; every minute Lane Pilot reads the tickets of the machines with writers at work and hands each,
 * once, to the PM of that writer's run. The PM answers with lane_pilot_permit — the ticket decision form: allow or deny with why. A grant is
 * used once by exactly that command; the writer is told in its thread. With owner.words on, the PM asks the owner before it answers.
 */
const SENT = "lp.permits.sent";
const ROUTES = "lp.permits.routes";

type Ticket = { session: string; ticket: string; category: string; command: string; cwd: string; at: number };

function routeKey(hostId: string, session: string, ticket: string): string {
  return `${hostId}\n${session}\n${ticket}`;
}

/** cwd is inside workspace, not merely a string prefix (`/fixture/a` does not own `/fixture/ab`). */
function workspaceOwns(cwd: string, workspace: string): boolean {
  const root = workspace.endsWith("/") ? workspace.slice(0, -1) : workspace;
  return cwd === root || cwd.startsWith(`${root}/`);
}

function attemptForCwd(db: ServerCore["db"], hostId: string, cwd: string, open: ReturnType<typeof listOpenAttempts>) {
  let best: { id: string; run_id: string; task_id: string; thread_id: string | null; root: string } | undefined;
  for (const row of open) {
    if (row.state !== "running" || getRunWriterHost(db, row.run_id) !== hostId) continue;
    const workspace = getAttempt(db, row.id)?.workspace_path;
    if (!workspace || !workspaceOwns(cwd, workspace)) continue;
    const root = workspace.endsWith("/") ? workspace.slice(0, -1) : workspace;
    if (!best || root.length > best.root.length) best = { id: row.id, run_id: row.run_id, task_id: row.task_id, thread_id: row.thread_id, root };
  }
  return best;
}

export function mountPermits(ctx: ServerCore): void {
  const { db, bb } = ctx;
  const host = () => bb.hosts.experimental_client({ contract: hostContract });
  const sent = async () => new Set(((await bb.storage.kv.get(SENT).catch(() => null)) as string[] | null) ?? []);
  const routes = async () => ((await bb.storage.kv.get(ROUTES).catch(() => null)) as Record<string, string> | null) ?? {};

  scheduleIsolated(bb, "permit-sweep", "* * * * *", async (signal) => {
    if (ctx.isDisposed() || signal?.aborted) return;
    const open = listOpenAttempts(db);
    const hosts = new Set(open.map((row) => getRunWriterHost(db, row.run_id)).filter((id): id is string => !!id));
    const told = await sent();
    const bound = await routes();
    let dirty = false;
    for (const hostId of hosts) {
      const answer = await host().call("listPermitTickets", { requestedHostId: hostId }, { hostId, timeoutMs: 10_000 }).catch(() => null);
      for (const ticket of (answer?.tickets ?? []) as Ticket[]) {
        const key = routeKey(hostId, ticket.session, ticket.ticket);
        // Same command hash in two sessions is two requests. (2026-10-29 audit A-025)
        if (told.has(key)) continue;
        const attempt = attemptForCwd(db, hostId, ticket.cwd, open);
        const run = attempt ? getRun(db, attempt.run_id) : undefined;
        if (!attempt || !run?.pm_thread_id) continue;
        try {
          await bb.sdk.threads.send({ threadId: run.pm_thread_id, mode: "queue-if-active", input: [{ type: "text", mentions: [], text:
            `[Lane Pilot permit] The writer of ${attempt.task_id} asks permission (${ticket.category}): \`${ticket.command.slice(0, 600)}\`. Decide with lane_pilot_permit {hostId:"${hostId}", session:"${ticket.session}", ticket:"${ticket.ticket}", decision:"allow"|"deny", why}. Allow only what the task needs; with owner.words on, ask the owner first.` }] } as never);
        } catch {
          continue;
        }
        told.add(key);
        bound[key] = attempt.id;
        dirty = true;
      }
    }
    if (!dirty) return;
    await bb.storage.kv.set(SENT, [...told].slice(-500) as never).catch(() => undefined);
    await bb.storage.kv.set(ROUTES, Object.fromEntries(Object.entries(bound).slice(-500)) as never).catch(() => undefined);
  }, { timeoutMs: 60_000 });

  registerObservedTool(bb.agents, {
    name: "lane_pilot_permit",
    description: "Answer a writer's permit ticket: allow or deny the one command the guard would refuse (deleting for good, DROP/TRUNCATE), with why.",
    instructions: "Use for a ticket Lane Pilot sent you. Allow only a command the task needs (a file the contract owns, a scratch table); deny anything else with why. A grant is used once, by exactly that command; the writer is told in its thread.",
    parameters: z.object({ hostId: z.string().min(1), session: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), ticket: z.string().regex(/^[a-f0-9]{16}$/), decision: z.enum(["allow", "deny"]), why: z.string().trim().min(1).max(600) }).strict(),
    execute: async (input) => {
      const open = listOpenAttempts(db);
      const key = routeKey(input.hostId, input.session, input.ticket);
      const boundId = (await routes())[key];
      let attempt = boundId ? open.find((row) => row.id === boundId && row.state === "running" && getRunWriterHost(db, row.run_id) === input.hostId) : undefined;
      if (!attempt) {
        const listed = await host().call("listPermitTickets", { requestedHostId: input.hostId }, { hostId: input.hostId, timeoutMs: 10_000 }).catch(() => null);
        const ticket = ((listed?.tickets ?? []) as Ticket[]).find((item) => item.session === input.session && item.ticket === input.ticket);
        const matched = ticket ? attemptForCwd(db, input.hostId, ticket.cwd, open) : undefined;
        attempt = matched ? open.find((row) => row.id === matched.id) : undefined;
      }
      const written = await host().call("answerPermit", { requestedHostId: input.hostId, session: input.session, ticket: input.ticket, decision: input.decision, why: input.why }, { hostId: input.hostId, timeoutMs: 10_000 });
      if (!written.written) throw new ToolError(`no ticket ${input.ticket} on ${input.hostId}`, { code: "no_ticket", retryable: false, sideEffects: "none" });
      if (attempt?.thread_id) await bb.sdk.threads.send({ threadId: attempt.thread_id, mode: "queue-if-active", input: [{ type: "text", mentions: [], text: `[Lane Pilot] Permit ${input.ticket}: ${input.decision === "allow" ? "granted — run the same command again, once" : `refused — ${input.why}`}.` }] } as never).catch(() => undefined);
      return JSON.stringify({ ticket: input.ticket, decision: input.decision, written: true });
    },
  });
}

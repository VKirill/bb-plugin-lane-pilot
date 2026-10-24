import { z } from "zod";
import { ToolError, registerObservedTool, scheduleIsolated, type ServerCore } from "../core/server";
import { hostContract } from "../contracts";
import { getAttempt, getRun, listOpenAttempts } from "../storage";

/**
 * Permits (SMA map: Permission before an act, Permit channel for the worker, Permit channel opened, Ticket awaits a decision, Approve or deny
 * the call, Ticket decision form). A writer whose command the guard would refuse (deleting for good, DROP/TRUNCATE) files a ticket on its
 * machine instead of only being refused; every minute Lane Pilot reads the tickets of the machines with writers at work and hands each,
 * once, to the PM of that writer's run. The PM answers with lane_pilot_permit — the ticket decision form: allow or deny with why. A grant is
 * used once by exactly that command; the writer is told in its thread. With owner.words on, the PM asks the owner before it answers.
 */
const SENT = "lp.permits.sent";

export function mountPermits(ctx: ServerCore): void {
  const { db, bb } = ctx;
  const host = () => bb.hosts.experimental_client({ contract: hostContract });
  const sent = async () => new Set(((await bb.storage.kv.get(SENT).catch(() => null)) as string[] | null) ?? []);

  scheduleIsolated(bb, "permit-sweep", "* * * * *", async (signal) => {
    if (ctx.isDisposed() || signal?.aborted) return;
    const open = listOpenAttempts(db).filter((row) => row.state === "running");
    const hosts = new Set(open.map((row) => (db.prepare("SELECT writer_host_id FROM lane_pilot_run WHERE id=?").get(row.run_id) as { writer_host_id?: string } | undefined)?.writer_host_id).filter((id): id is string => !!id));
    const told = await sent();
    for (const hostId of hosts) {
      const answer = await host().call("listPermitTickets", { requestedHostId: hostId }, { hostId, timeoutMs: 10_000 }).catch(() => null);
      for (const ticket of answer?.tickets ?? []) {
        if (told.has(`${hostId}:${ticket.ticket}`)) continue;
        const attempt = open.find((row) => { const path = getAttempt(db, row.id)?.workspace_path; return !!path && ticket.cwd.startsWith(path); });
        const run = attempt ? getRun(db, attempt.run_id) : undefined;
        if (!attempt || !run?.pm_thread_id) continue;
        await bb.sdk.threads.send({ threadId: run.pm_thread_id, mode: "queue-if-active", input: [{ type: "text", mentions: [], text:
          `[Lane Pilot permit] The writer of ${attempt.task_id} asks permission (${ticket.category}): \`${ticket.command.slice(0, 600)}\`. Decide with lane_pilot_permit {hostId:"${hostId}", session:"${ticket.session}", ticket:"${ticket.ticket}", decision:"allow"|"deny", why}. Allow only what the task needs; with owner.words on, ask the owner first.` }] } as never).catch(() => undefined);
        told.add(`${hostId}:${ticket.ticket}`);
      }
    }
    await bb.storage.kv.set(SENT, [...told].slice(-500) as never).catch(() => undefined);
  }, { timeoutMs: 60_000 });

  registerObservedTool(bb.agents, {
    name: "lane_pilot_permit",
    description: "Answer a writer's permit ticket: allow or deny the one command the guard would refuse (deleting for good, DROP/TRUNCATE), with why.",
    instructions: "Use for a ticket Lane Pilot sent you. Allow only a command the task needs (a file the contract owns, a scratch table); deny anything else with why. A grant is used once, by exactly that command; the writer is told in its thread.",
    parameters: z.object({ hostId: z.string().min(1), session: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), ticket: z.string().regex(/^[a-f0-9]{16}$/), decision: z.enum(["allow", "deny"]), why: z.string().trim().min(1).max(600) }).strict(),
    execute: async (input) => {
      const written = await host().call("answerPermit", { requestedHostId: input.hostId, session: input.session, ticket: input.ticket, decision: input.decision, why: input.why }, { hostId: input.hostId, timeoutMs: 10_000 });
      if (!written.written) throw new ToolError(`no ticket ${input.ticket} on ${input.hostId}`, { code: "no_ticket", retryable: false, sideEffects: "none" });
      const attempt = listOpenAttempts(db).find((row) => row.state === "running" && row.thread_id && (db.prepare("SELECT writer_host_id FROM lane_pilot_run WHERE id=?").get(row.run_id) as { writer_host_id?: string } | undefined)?.writer_host_id === input.hostId);
      if (attempt?.thread_id) await bb.sdk.threads.send({ threadId: attempt.thread_id, mode: "queue-if-active", input: [{ type: "text", mentions: [], text: `[Lane Pilot] Permit ${input.ticket}: ${input.decision === "allow" ? "granted — run the same command again, once" : `refused — ${input.why}`}.` }] } as never).catch(() => undefined);
      return JSON.stringify({ ticket: input.ticket, decision: input.decision, written: true });
    },
  });
}

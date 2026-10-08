import { randomBytes } from "node:crypto";
import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../contracts";
import type { ServerCore } from "./core";

/**
 * The owner's yes for an incident deploy (audit 2026-10-08 round 3, P0-5). `bb-plugin-push` lets a second deploy in a day, or a
 * deploy with the error budget used up, through only as an incident, and an incident needs a reference the hub can confirm:
 * a self-repair incident (`self_repair_status`) or this request. The push script calls `deploy_incident_request` with the
 * reason, version and commit; the owner gets a form in a PM chat (and on the phone, as for every owner question) and answers
 * yes or no. The script polls with the request id for up to its wait, and the answer opens that one commit's deploy once
 * (`consume`). A label typed into an environment variable never opens it.
 */
export const INCIDENT_ASK_TIMEOUT_MS = 30 * 60_000;
/** A yes is used within this, or it lapses. */
export const INCIDENT_APPROVAL_TTL_MS = 10 * 60_000;
/** After a no, the same commit is not put to the owner again for this long. */
export const INCIDENT_DENIED_QUIET_MS = 10 * 60_000;
const KEY = "deploy-incident:";

export type IncidentState = "pending" | "approved" | "denied" | "expired" | "consumed" | "unavailable" | "unknown";
type IncidentRecord = {
  id: string; state: IncidentState; reason: string; version: string; sha: string; requestedBy: string; threadId: string | null;
  at: number; answeredAt?: number; message?: string;
};
type Input = { requestId?: string; reason?: string; version?: string; sha?: string; requestedBy?: string; threadId?: string; consume?: boolean };

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function createDeployIncident(ctx: Pick<ServerCore, "bb" | "db" | "ownerAsk">, now: () => number = Date.now) {
  const { bb, db, ownerAsk } = ctx;

  const load = async (id: string) => (await bb.storage.kv.get<IncidentRecord>(`${KEY}${id}`).catch(() => null)) ?? null;
  const save = async (record: IncidentRecord) => { await bb.storage.kv.set(`${KEY}${record.id}`, record as never); };
  const view = (record: IncidentRecord) => ({ requestId: record.id, state: record.state, version: record.version, sha: record.sha, reason: record.reason, askedIn: record.threadId, ...(record.message ? { message: record.message } : {}) });

  /** The chat the form opens in: the given one, or the most recent PM chat. */
  function threadFor(given: string | undefined): string | null {
    if (given) return given;
    return (db.prepare("SELECT pm_thread_id FROM lane_pilot_activation ORDER BY rowid DESC LIMIT 1").get() as { pm_thread_id: string } | undefined)?.pm_thread_id ?? null;
  }

  async function all(): Promise<IncidentRecord[]> {
    const rows: IncidentRecord[] = [];
    for (const key of await bb.storage.kv.list(KEY).catch(() => [] as string[])) {
      const record = await bb.storage.kv.get<IncidentRecord>(key).catch(() => null);
      if (record) rows.push(record);
    }
    return rows.sort((a, b) => b.at - a.at);
  }

  async function open(input: Input): Promise<ReturnType<typeof view>> {
    const reason = clip((input.reason ?? "").trim(), 300);
    const sha = (input.sha ?? "").trim().slice(0, 64);
    if (!reason || !sha) return view({ id: "", state: "unknown", reason, version: "", sha, requestedBy: "", threadId: null, at: now(), message: "reason and sha are required" });
    const known = await all();
    // One form at a time: anyone who can call this RPC must not be able to fill the owner's chat with questions.
    const pending = known.find((row) => row.state === "pending" && row.at + INCIDENT_ASK_TIMEOUT_MS > now());
    if (pending && pending.sha === sha) return view(pending);
    if (pending) return view({ ...pending, state: "unavailable", message: "Another incident request is waiting for the owner; ask again once it is answered." });
    const denied = known.find((row) => row.sha === sha && row.state === "denied" && (row.answeredAt ?? row.at) + INCIDENT_DENIED_QUIET_MS > now());
    if (denied) return view({ ...denied, message: "The owner declined this commit a short while ago; do not try to work around it." });
    const record: IncidentRecord = {
      id: `dinc_${randomBytes(6).toString("hex")}`, state: "pending", reason, version: clip(input.version ?? "", 40), sha,
      requestedBy: clip(input.requestedBy ?? "", 120), threadId: threadFor(input.threadId), at: now(),
    };
    if (!record.threadId || !ownerAsk.available()) {
      record.state = "unavailable";
      record.message = record.threadId ? "This BB cannot show the owner a form." : "No PM chat is open to ask in: open a Lane Pilot PM chat in BB, then ask again.";
      await save(record);
      return view(record);
    }
    await save(record);
    const shown = await ownerAsk.askInBackground(record.threadId, {
      source: "gate",
      question: `Allow an incident deploy of Lane Pilot ${record.version || "(version unknown)"}?`,
      detail: [
        `Commit ${record.sha}. Reason given: ${record.reason}`,
        ...(record.requestedBy ? [`Asked by: ${record.requestedBy}`] : []),
        "",
        "An incident deploy skips the one-deploy-a-day rule and the error budget. Tests, the drill and the rollback still run. If you did not start a deploy yourself or an agent did not tell you about one, say no.",
        `A yes covers this commit only and lasts ${INCIDENT_APPROVAL_TTL_MS / 60_000} minutes.`,
      ].join("\n"),
      options: ["Allow this deploy", "Do not allow"],
      allowText: false,
    }, async (answer) => {
      const current = (await load(record.id)) ?? record;
      if (current.state !== "pending") return;
      current.answeredAt = now();
      current.state = answer.outcome === "answered" && answer.choice?.id === "1" ? "approved" : answer.outcome === "cancelled" && answer.reason === "timeout" ? "expired" : "denied";
      await save(current);
      bb.log.warn(`Lane Pilot: incident deploy of ${current.version} (${current.sha}) ${current.state} by the owner's answer (${current.id}); reason: ${current.reason}`);
    }, { timeoutMs: INCIDENT_ASK_TIMEOUT_MS }).catch(() => false);
    if (!shown) {
      record.state = "unavailable";
      record.message = "The owner's form could not be shown (a question is already open in that chat, or BB cannot show forms).";
      await save(record);
    }
    return view(record);
  }

  async function poll(input: Input): Promise<ReturnType<typeof view>> {
    const record = await load(input.requestId ?? "");
    if (!record) return view({ id: input.requestId ?? "", state: "unknown", reason: "", version: "", sha: input.sha ?? "", requestedBy: "", threadId: null, at: now(), message: "no such request (the plugin may have been reloaded before the owner answered)" });
    if (record.state === "pending" && record.at + INCIDENT_ASK_TIMEOUT_MS < now()) { record.state = "expired"; await save(record); }
    if (record.state === "approved") {
      if ((record.answeredAt ?? 0) + INCIDENT_APPROVAL_TTL_MS < now()) { record.state = "expired"; await save(record); }
      else if (input.sha && input.sha !== record.sha) return view({ ...record, state: "unknown", message: "the answer was for another commit" });
      else if (input.consume) { record.state = "consumed"; await save(record); return view({ ...record, state: "approved" }); }
    }
    return view(record);
  }

  return { request: (input: Input) => (input.requestId ? poll(input) : open(input)) };
}

export function deployIncidentRpc(ctx: ServerCore) {
  const incident = createDeployIncident(ctx);
  return {
    deploy_incident_request: async (input) => incident.request(input),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "deploy_incident_request">;
}

import type { PublishGrant, PublishGrantVia } from "@lane-pilot/contracts";
import {
  consumePublishAuthorityRow,
  createDraftStore,
  draftDefinitionSha256,
  insertOwnerPublishGrant,
  peekPublishAuthority,
  type ConsumeAuthorityResult,
} from "@lane-pilot/workflow-engine";
import { TURN_REQUESTED, isOwnerInitiatedTurn, isServiceNoticeText } from "../../../contracts";
import type { ServerCore } from "../../../contracts/server";
import type { LanePilotDatabase } from "../../../storage";

export { draftDefinitionSha256 as draftSha256 };

export type PublishGateLog = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

/** Adapts a ServerCore logger to info/warn sinks for publish-gate audit lines. */
export function publishGateLog(ctx: { bb?: { log?: { info?: (m: string) => void; warn?: (m: string) => void } }; log?: (m: string) => void }): PublishGateLog {
  return {
    info: (m) => { if (ctx.bb?.log?.info) ctx.bb.log.info(m); else ctx.log?.(m); },
    warn: (m) => { if (ctx.bb?.log?.warn) ctx.bb.log.warn(m); else ctx.log?.(m); },
  };
}

/** Issues an owner publish grant bound to the draft's current definition SHA-256. */
export function grantOwner(
  db: LanePilotDatabase,
  draftId: string,
  via: PublishGrantVia,
  options: { now?: number; log?: PublishGateLog } = {},
): PublishGrant | null {
  const grant = insertOwnerPublishGrant(db, draftId, via, { now: options.now });
  if (grant) {
    options.log?.info(`publish authority kind=owner draft=${draftId} sha=${grant.draftSha256.slice(0, 8)}`);
  }
  return grant;
}

/** Checks without consuming whether an unused publish authority matches `(draftId, sha)`. */
export function peekAuthority(db: LanePilotDatabase, draftId: string, sha: string): ConsumeAuthorityResult {
  return peekPublishAuthority(db, draftId, sha);
}

/** Atomically consumes a matching unused publish authority row, logging a warning on refusal. */
export function consumeAuthority(
  db: LanePilotDatabase,
  draftId: string,
  sha: string,
  options: { now?: number; log?: PublishGateLog } = {},
): ConsumeAuthorityResult {
  const res = consumePublishAuthorityRow(db, draftId, sha, { now: options.now });
  if (!res.ok) {
    options.log?.warn(`publish refused draft=${draftId} reason=${res.reason}`);
  }
  return res;
}

const CHAT_CONFIRM_TTL_MS = 15 * 60_000;
const AGENT_ENVELOPE_RE = /^\[bb message from thread:[^;\]\s]+(?:;[^\]]*)?\]\s*/;
const ASK_OWNER_RESULT_RE = /^(?:Lane Pilot: the owner answered\b|\*\*Владелец ответил\*\*|\*\*The owner answered\*\*)/;
const NEGATIVE_PUBLISH_RE = /^(?:no|нет|отмена|отказ|cancel|reject|decline|не\s+надо|не\s+публикуй)\b|\b(?:don'?t|do\s+not|never|not)\s+(?:publish|approve|confirm)\b|не\s+(?:публикуй|опубликуй|публиковать|подтверждаю|надо)/i;
const EXPLICIT_PUBLISH_RE = /\b(publish|confirm|approve|ship|go\s+ahead)\b|(?:^|[\s,.:;!?«»"'()])(опублику[йю]|публику[йю]|публиковать|подтверждаю|одобряю|утверждаю|выкатывай)(?:$|[\s,.:;!?«»"'()])/i;
const AFFIRMATIVE_RE = /\b(yes|ok|okay|sure|agreed?|yep|yeah)\b|(?:^|[\s,.:;!?«»"'()])(да|ок|ага|хорошо|согласен|подтверждаю|ладно|давай)(?:$|[\s,.:;!?«»"'()])/i;
const PUBLISH_QUESTION_RE = /\b(publish|workflow|draft|chain)\b|(?:публик|опублик|граф|черновик|цепочк)/i;

const consumedTurnEvents = new Set<string>();

function isExplicitPublishConfirmation(choice: string | null, text: string | null, question?: string | null): boolean {
  const parts = [choice ?? "", text ?? ""].map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return false;
  const combined = parts.join(" ");
  if (NEGATIVE_PUBLISH_RE.test(combined)) return false;
  if (EXPLICIT_PUBLISH_RE.test(combined)) return true;
  if (question && PUBLISH_QUESTION_RE.test(question) && AFFIRMATIVE_RE.test(combined)) return true;
  return false;
}

type TurnEvent = { seq?: unknown; createdAt?: unknown; data?: unknown };

function visibleTurnText(data: Record<string, unknown>): string {
  const groups = (Array.isArray(data.inputGroups) ? data.inputGroups : [data.input]) as unknown[];
  const texts: string[] = [];
  for (const input of groups) {
    if (!Array.isArray(input)) continue;
    for (const part of input) {
      if (!part || typeof part !== "object") continue;
      const rec = part as { type?: unknown; text?: unknown; visibility?: unknown };
      if (rec.type !== "text" || rec.visibility === "agent-only") continue;
      if (typeof rec.text === "string" && rec.text.trim()) texts.push(rec.text);
    }
  }
  return texts.join("\n").trim();
}

/**
 * Verifies whether the owner explicitly confirmed publication in the current chat turn
 * (via `lane_pilot_ask_owner` answer or an owner-initiated `client/turn/requested` message)
 * and issues a one-time `"chat"` publish grant if confirmed.
 */
export async function grantOwnerFromChatConfirmation(
  ctx: Pick<ServerCore, "db" | "bb" | "log"> & Partial<Pick<ServerCore, "ownerAsk">>,
  threadId: string,
  draftId: string,
  options: { now?: number } = {},
): Promise<PublishGrant | null> {
  const log = publishGateLog(ctx);
  const draft = createDraftStore(ctx.db).get(draftId);
  if (!draft) return null;
  const currentSha = draftDefinitionSha256(draft.definition);
  if (peekAuthority(ctx.db, draftId, currentSha).ok) return null;

  const now = options.now ?? Date.now();
  const answered = ctx.ownerAsk?.lastAnswered?.(threadId);
  if (answered && now - answered.at <= CHAT_CONFIRM_TTL_MS) {
    if (isExplicitPublishConfirmation(answered.choice, answered.text, answered.question)) {
      ctx.ownerAsk?.consumeLastAnswered?.(threadId);
      return grantOwner(ctx.db, draftId, "chat", { now, log });
    }
  }

  const eventsApi = ctx.bb?.sdk?.threads?.events;
  if (typeof eventsApi?.list !== "function") return null;

  let listed: unknown;
  try {
    listed = await eventsApi.list({ threadId, types: [TURN_REQUESTED], order: "desc", limit: "10" });
  } catch {
    return null;
  }
  if (!Array.isArray(listed) || listed.length === 0) return null;

  const newest = listed[0] as TurnEvent;
  const data = newest?.data && typeof newest.data === "object" ? (newest.data as Record<string, unknown>) : null;
  if (!data || !isOwnerInitiatedTurn(data)) return null;

  const seq = typeof newest.seq === "number" || typeof newest.seq === "string" ? String(newest.seq) : "";
  const eventKey = seq ? `${threadId}:${seq}` : "";
  if (eventKey && consumedTurnEvents.has(eventKey)) return null;

  const text = visibleTurnText(data);
  if (!text || AGENT_ENVELOPE_RE.test(text)) return null;
  if (isServiceNoticeText(text) && !ASK_OWNER_RESULT_RE.test(text)) return null;
  if (!isExplicitPublishConfirmation(null, text, ASK_OWNER_RESULT_RE.test(text) ? text : undefined)) return null;

  if (eventKey) {
    if (consumedTurnEvents.size >= 1000) consumedTurnEvents.delete(consumedTurnEvents.values().next().value!);
    consumedTurnEvents.add(eventKey);
  }
  return grantOwner(ctx.db, draftId, "chat", { now, log });
}

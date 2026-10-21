import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** A limit error this long before the writer's last event still counts: the session's first error follows that event at once. */
const SINCE_SLACK_MS = 60_000;
/** The newest assistant messages of the session that are read: a silent writer's provider error sits on its last turn. */
const MESSAGES = 10;
const FETCH_MS = 10_000;
const UNIT_MS: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1_000 };

/** A provider limit a session's error names: the model that hit it, and its reset time (epoch ms) when the error gives one. */
export type OpenCodeLimit = { status: "limit"; providerId: string | null; model: string | null; resetAt: number | null; reason: string };
export type OpenCodeLimitResult = OpenCodeLimit | { status: "none"; providerId: null; model: null; resetAt: null; reason: null };

/** OpenCode v2's `Session.StructuredError` and the parts of an assistant message (`GET /api/session/:id/message`) read here. */
export type OpenCodeError = { type: string; message: string; status?: number; response?: { body: string }; retryAfterMs?: number };
export type OpenCodeAssistantMessage = {
  type: string;
  time?: { created?: number; completed?: number };
  model?: { id?: string; providerID?: string } | null;
  error?: OpenCodeError | null;
  retry?: { attempt: number; at: number; error: OpenCodeError } | null;
};

/** The error types OpenCode v2 gives a spent limit; a provider that reports it only as a plain error is caught by its text. */
const LIMIT_TYPES = new Set(["provider.rate-limit", "provider.quota", "provider.free-limit"]);
const LIMIT_TEXT = /\[429\]|\b429\b|quota|rate[ -]?limit|usage limit|insufficient credits|credit balance|RESOURCE_EXHAUSTED|too many requests|Unavailable \(reset after/i;
const RESET_STAMP = /quotaResetTimeStamp\\?"\s*:\s*\\?"([^"\\\s]+)/;
const RESET_AFTER = /(?:reset after |[Rr]esets in )((?:\d+(?:\.\d+)?[hms] ?)+)/;
const MODEL_IN_ERROR = /\[([^\]\s]+\/[^\]\s]+)\]/;
const NONE: OpenCodeLimitResult = { status: "none", providerId: null, model: null, resetAt: null, reason: null };

/** `2h 40m 47s`, `4h43m12s`, `1m 30s` as milliseconds. */
function durationMs(text: string): number {
  return [...text.matchAll(/(\d+(?:\.\d+)?)([hms])/g)].reduce((total, match) => total + Number(match[1]) * UNIT_MS[match[2]!]!, 0);
}

/**
 * The limit one error names, or null when it names none. `at` is when the error happened: `retryAfterMs` and a «reset after»
 * count from it. The model in the error's text, when it names one, is the one that hit the limit (a router's upstream model).
 */
export function limitOfError(error: OpenCodeError, at: number | null, model: { id?: string; providerID?: string } | null | undefined): Omit<OpenCodeLimit, "status"> | null {
  const text = `${error.message}\n${error.response?.body ?? ""}`;
  const matched = LIMIT_TEXT.exec(text);
  if (!LIMIT_TYPES.has(error.type) && error.status !== 429 && !matched) return null;
  const stamp = Date.parse(RESET_STAMP.exec(text)?.[1] ?? "");
  const after = RESET_AFTER.exec(text)?.[1];
  const resetAt = Number.isFinite(stamp) ? stamp
    : at !== null && typeof error.retryAfterMs === "number" ? at + error.retryAfterMs
    : at !== null && after ? at + durationMs(after)
    : null;
  const own = model?.providerID && model.id ? `${model.providerID}/${model.id}` : null;
  return {
    providerId: model?.providerID ?? null,
    model: MODEL_IN_ERROR.exec(text)?.[1] ?? own,
    resetAt,
    reason: error.message.replace(/\s+/g, " ").slice(0, 160) || matched?.[0] || error.type,
  };
}

/**
 * The provider limit the session's newest assistant messages name since `sinceMs`, newest first: a retry OpenCode has scheduled
 * (the turn still waits on it) or the error the turn ended with. Errors that name no limit classify as none: a silent writer whose
 * provider is fine is nudged as before.
 */
export function classifyOpenCodeLimit(messages: OpenCodeAssistantMessage[], sinceMs: number): OpenCodeLimitResult {
  const newest = [...messages].sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0));
  for (const message of newest) {
    if (message.type !== "assistant") continue;
    const created = message.time?.created ?? null;
    if (message.retry) {
      if (message.retry.at >= sinceMs - SINCE_SLACK_MS) {
        const limit = limitOfError(message.retry.error, message.retry.at, message.model);
        if (limit) return { status: "limit", ...limit };
      }
    }
    if (message.error && (created === null || (message.time?.completed ?? created) >= sinceMs - SINCE_SLACK_MS)) {
      const limit = limitOfError(message.error, message.time?.completed ?? created, message.model);
      if (limit) return { status: "limit", ...limit };
    }
  }
  return NONE;
}

/** Where the OpenCode v2 background service writes its URL and password: `$XDG_STATE_HOME/opencode`, else `~/.local/state/opencode`. */
export function openCodeServicePath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_STATE_HOME ? join(env.XDG_STATE_HOME, "opencode") : join(homedir(), ".local", "state", "opencode");
  return join(base, "service.json");
}

/**
 * The host's answer for one writer session, read from the OpenCode v2 service's own API (the session's assistant messages
 * carry `error` and `retry` as `Session.StructuredError`). A service that is not running or answers with an error throws to
 * the caller.
 */
export async function probeOpenCodeLimit(input: {
  sessionId: string; sinceMs: number; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch;
}): Promise<OpenCodeLimitResult> {
  const env = input.env ?? process.env;
  const service = JSON.parse(await readFile(openCodeServicePath(env), "utf8")) as { url?: unknown; password?: unknown };
  if (typeof service.url !== "string" || !service.url) throw new Error("opencode_service_unknown: service.json names no url");
  const password = env.OPENCODE_SERVER_PASSWORD ?? (typeof service.password === "string" ? service.password : "");
  const username = env.OPENCODE_SERVER_USERNAME ?? "opencode";
  const url = new URL(`/api/session/${encodeURIComponent(input.sessionId)}/message`, service.url);
  url.search = new URLSearchParams({ limit: String(MESSAGES), order: "desc", type: "assistant" }).toString();
  const response = await (input.fetchImpl ?? fetch)(url, {
    headers: { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` },
    signal: AbortSignal.timeout(FETCH_MS),
  });
  if (!response.ok) throw new Error(`opencode_service_http_${response.status}: ${(await response.text()).slice(0, 200)}`);
  const body = await response.json() as { data?: unknown };
  return classifyOpenCodeLimit(Array.isArray(body.data) ? body.data as OpenCodeAssistantMessage[] : [], input.sinceMs);
}

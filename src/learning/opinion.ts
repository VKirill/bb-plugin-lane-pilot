import { z } from "zod";
import { MESSAGE_KINDS, SCOPES, learnShare, routeOf, type MessageInput, type MessageKind, type MessageSignals, type Route, type RouteThresholds, type Scope } from "./judgment";

/**
 * The second opinion (T2): OpenAI Decisions (`POST /v1/decisions`, model `gpt-6-luna`) answers the same questions as Jev, so the two
 * are comparable field by field. It is asked only for a contested message, when Jev cannot answer, and for a small sample for the
 * agreement report; never for a sensitive message (that one stays with Jev alone). The key is read from the Env Catalog by name
 * (`OPENAI_API_KEY`) at each call through `apiKey`, kept in memory for ten minutes and never logged or stored.
 *
 * Measured on 171 messages: 200 ms median, 274 ms p90, about 1.1k input tokens a message, $0.10 per million input tokens, so a
 * hundred second opinions cost about one cent. It never throws: a failure is a result, and a breaker pauses it after five in a row.
 */
export const DECISIONS_URL = "https://api.openai.com/v1/decisions";
export const DECISIONS_MODEL = "gpt-6-luna";
/** USD per million input tokens (src/model-prices.ts), for the cost line of the report. */
export const DECISIONS_USD_PER_MILLION_INPUT = 0.1;
export const KEY_NAME = "OPENAI_API_KEY";

export type SecondOpinion =
  | { ok: true; signals: MessageSignals; route: Route; tokensIn: number; latencyMs: number; model: string }
  | { ok: false; status: "disabled" | "error" | "timeout" | "invalid" | "breaker_open"; error: string; latencyMs: number };

export type DecisionsDeps = {
  apiKey(): Promise<string | undefined>;
  fetch?: typeof fetch;
  now?: () => number;
  url?: string;
  model?: string;
  timeoutMs?: number;
};

const answerSchema = z.object({
  type: z.string(), name: z.string(),
  choice: z.string().optional(), probability: z.number().optional(), score: z.number().optional(),
  probabilities: z.array(z.object({ value: z.union([z.string(), z.number()]), probability: z.number() })).optional(),
}).passthrough();
const responseSchema = z.object({
  model: z.string().optional(),
  answers: z.array(answerSchema),
  usage: z.object({ input_tokens: z.number().optional() }).passthrough().optional(),
}).passthrough();

const QUESTIONS = [
  { type: "choice", name: "kind", instructions: "What is the main purpose of the owner message (the owner writing to an AI agent in a work chat)? The previous agent reply, if given, is context.",
    choices: Object.entries(MESSAGE_KINDS).map(([value, description]) => ({ value, description })) },
  { type: "predicate", name: "durable", instructions: "Does the owner message contain something that an AI assistant should remember for FUTURE sessions (a lasting preference, rule, correction pattern, decision or fact), not only for the current task?" },
  { type: "choice", name: "scope", instructions: "If something in the owner message should be remembered, how widely does it apply?",
    choices: Object.entries(SCOPES).map(([value, description]) => ({ value, description })) },
  { type: "predicate", name: "deadline", instructions: "Does the owner message name a date, a deadline, a reminder or something the agent promised or must do later?" },
  { type: "score", name: "frustration", instructions: "How frustrated or dissatisfied with the agent is the owner?",
    levels: [{ label: "calm", description: "calm" }, { label: "mild", description: "mildly dissatisfied" }, { label: "frustrated", description: "clearly frustrated" }] },
] as const;

const FAILURES_TO_OPEN = 5, OPEN_MS = 5 * 60_000;

export function createDecisionsClient(deps: DecisionsDeps) {
  const doFetch = deps.fetch ?? fetch, now = deps.now ?? Date.now;
  const url = deps.url ?? DECISIONS_URL, model = deps.model ?? DECISIONS_MODEL, timeoutMs = deps.timeoutMs ?? 10_000;
  let failures = 0, openUntil = 0;
  return {
    breaker: () => ({ open: now() < openUntil, failures }),
    async ask(input: MessageInput, thresholds?: RouteThresholds): Promise<SecondOpinion> {
      const started = now();
      const fail = (status: Exclude<SecondOpinion, { ok: true }>["status"], error: string): SecondOpinion => ({ ok: false, status, error, latencyMs: now() - started });
      const key = (await deps.apiKey().catch(() => undefined))?.trim();
      if (!key) return fail("disabled", `no ${KEY_NAME}`);
      if (now() < openUntil) return fail("breaker_open", "too many recent failures");
      const body = JSON.stringify({ model, input: `PREVIOUS AGENT REPLY (context):\n${input.prev || "(none)"}\n\nOWNER MESSAGE (judge this):\n${input.text}`, questions: QUESTIONS });
      const breaker = () => { failures += 1; if (failures >= FAILURES_TO_OPEN) { openUntil = now() + OPEN_MS; failures = 0; } };
      let response: Response;
      try {
        response = await doFetch(url, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body, signal: AbortSignal.timeout(timeoutMs) });
      } catch (cause) {
        breaker();
        return fail(cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError") ? "timeout" : "error", cause instanceof Error ? cause.message.replaceAll(key, "***") : "request failed");
      }
      if (!response.ok) {
        if (response.status === 429 || response.status >= 500) breaker();
        return fail("error", `http ${response.status}`);
      }
      const parsed = responseSchema.safeParse(await response.json().catch(() => null));
      const signals = parsed.success ? signalsFromDecisions(parsed.data.answers) : null;
      if (!parsed.success || !signals) { breaker(); return fail("invalid", "unreadable answer"); }
      failures = 0;
      return { ok: true, signals, route: routeOf(signals, thresholds), tokensIn: Math.round(parsed.data.usage?.input_tokens ?? 0), latencyMs: now() - started, model: parsed.data.model ?? model };
    },
  };
}
export type DecisionsClient = ReturnType<typeof createDecisionsClient>;

const round = (value: number) => Math.round(value * 1000) / 1000;

/** The answers of the Decisions API as the same signals Jev's give. */
export function signalsFromDecisions(answers: z.infer<typeof answerSchema>[]): MessageSignals | null {
  const byName = new Map(answers.map((answer) => [answer.name, answer]));
  const kind = byName.get("kind"), scope = byName.get("scope"), frustration = byName.get("frustration");
  if (kind?.type !== "choice" || !kind.probabilities?.length) return null;
  const kinds = Object.fromEntries(kind.probabilities.map((row) => [String(row.value), row.probability]));
  const top = Object.entries(kinds).sort((a, b) => b[1] - a[1])[0]!;
  const scopes = Object.fromEntries((scope?.probabilities ?? []).map((row) => [String(row.value), row.probability]));
  const topScope = Object.entries(scopes).sort((a, b) => b[1] - a[1])[0];
  const levels = Object.fromEntries((frustration?.probabilities ?? []).map((row) => [String(row.value), row.probability]));
  // «mild» and «frustrated» are labels as well as numbers in the Decisions API; read either.
  const level = (index: number, label: string) => levels[String(index)] ?? levels[label] ?? 0;
  return {
    kind: (top[0] in MESSAGE_KINDS ? top[0] : "other") as MessageKind, kindP: round(top[1]), learnP: round(learnShare(kinds)),
    durable: round(byName.get("durable")?.probability ?? 0),
    scope: (topScope && topScope[0] in SCOPES ? topScope[0] : "task") as Scope, scopeP: round(topScope?.[1] ?? 0),
    deadline: round(byName.get("deadline")?.probability ?? 0),
    frustration: round(level(2, "frustrated")), mild: round(level(1, "mild") + level(2, "frustrated")),
  };
}

export const usdOfTokens = (tokensIn: number): number => (tokensIn / 1_000_000) * DECISIONS_USD_PER_MILLION_INPUT;


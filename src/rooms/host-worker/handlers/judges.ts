import type { ExperimentalHostRpcHandlers } from "@get-bb/plugin-sdk";
import { hostContract } from "../../contracts";
import { jevCallFor } from "../jev-call";
import { sha256Hex } from "@lane-pilot/kit";
import { JEV_PROVIDERS } from "@lane-pilot/jev/provider";

/** The Jev credentials a method carries, when it carries them: every judge and docs builder takes them the same way. */
export const jevSource = (input: { jevApiKey?: string; jevProvider?: "openlux" | "typesafe" }) => ({ jevApiKey: input.jevApiKey, jevProvider: input.jevProvider });

const PLAN_EFFORT_QUESTION = {
  type:"choice",
  instructions:"Reasoning effort this turn needs. Pick the cheapest that still solves the task.",
  criteria:{
    low:"obvious, mechanical, follow an existing pattern; extra thinking is waste",
    medium:"normal implementation with local scope",
    high:"must think carefully; many tradeoffs or failure modes",
    xhigh:"deep architecture, concurrency, security, or wide blast radius; cheaper effort will miss it",
  },
} as const;

export const classifyPlan: ExperimentalHostRpcHandlers<typeof hostContract>["classifyPlan"] = async (input) => {
  const hostId = process.env.BB_HOST_ID ?? input.requestedHostId;
  const planSha256 = sha256Hex(input.plan);
  const sourceLength = Buffer.byteLength(input.plan, "utf8");
  const auth = await jevCallFor(input);
  const apiKey = auth?.key ?? "";
  const provider = auth?.provider ?? JEV_PROVIDERS.typesafe;
  const payload = { model:provider.model, state:{ task:input.plan }, questions:{ effort:PLAN_EFFORT_QUESTION } };
  const body = JSON.stringify(payload);
  const decodedPlan = (JSON.parse(body) as { state:{ task:string } }).state.task;
  const sentPlanSha256 = sha256Hex(decodedPlan);
  const sentLength = Buffer.byteLength(decodedPlan, "utf8");
  const transportProof = { planSha256, sentPlanSha256, sourceLength, sentLength };
  if (sentPlanSha256 !== planSha256 || sentLength !== sourceLength) {
    return { hostId, status:"error", effort:null, reason:"plan_serialization_mismatch", ...transportProof };
  }
  if (!apiKey) return { hostId, status:"disabled", effort:null, reason:"missing_typesafe_api_key",
    planSha256, sentPlanSha256:null, sourceLength, sentLength:null };
  try {
    const response = await fetch(provider.url, {
      method:"POST",
      headers:{ authorization:`Bearer ${apiKey}`, "content-type":"application/json" },
      body,
      signal:AbortSignal.timeout(2500 + provider.timeoutPadMs),
    });
    if (!response.ok) return { hostId, status:"error", effort:null, reason:`http_${response.status}`, ...transportProof };
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" || !("answers" in value)) {
      return { hostId, status:"error", effort:null, reason:"invalid_response", ...transportProof };
    }
    const answers = (value as { answers?: unknown }).answers;
    const effort = answers && typeof answers === "object"
      ? (answers as Record<string, { choice?: unknown }>).effort?.choice
      : undefined;
    if (typeof effort !== "string") return { hostId, status:"error", effort:null, reason:"missing_effort_answer", ...transportProof };
    return { hostId, status:"ok", effort, reason:null, ...transportProof };
  } catch (cause) {
    const reason = cause instanceof Error && cause.name === "TimeoutError" ? "timeout" : "api_request_failed";
    return { hostId, status:reason === "timeout" ? "timeout" : "error", effort:null, reason, ...transportProof };
  }
};

/** One System One call with several choice questions over a JSON state; the council's moderator and the seats' impulse to speak use it. */
export const councilJudge: ExperimentalHostRpcHandlers<typeof hostContract>["councilJudge"] = async (input) => {
  const hostId = process.env.BB_HOST_ID ?? input.requestedHostId;
  const auth = await jevCallFor(input);
  const apiKey = auth?.key ?? "";
  if (!apiKey || !auth) return { hostId, status:"disabled", answers:{}, reason:"missing_typesafe_api_key" };
  let state: unknown = input.state;
  try { state = JSON.parse(input.state); } catch { /* a plain text state is allowed */ }
  const questions = Object.fromEntries(Object.entries(input.questions).map(([name, question]) => [name, { type:"choice", instructions:question.instructions, criteria:question.criteria }]));
  try {
    const provider = auth.provider;
    const response = await fetch(provider.url, {
      method:"POST",
      headers:{ authorization:`Bearer ${apiKey}`, "content-type":"application/json" },
      body:JSON.stringify({ model:provider.model, state, questions }),
      signal:AbortSignal.timeout((input.timeoutMs ?? 4000) + provider.timeoutPadMs),
    });
    if (!response.ok) return { hostId, status:"error", answers:{}, reason:`http_${response.status}` };
    const value: unknown = await response.json();
    const raw = value && typeof value === "object" ? (value as { answers?: unknown }).answers : undefined;
    if (!raw || typeof raw !== "object") return { hostId, status:"error", answers:{}, reason:"invalid_response" };
    const answers: Record<string, string> = {};
    const confidence: Record<string, number> = {};
    const probabilities: Record<string, Record<string, number>> = {};
    for (const [name, answer] of Object.entries(raw as Record<string, { choice?: unknown; confidence?: unknown; probabilities?: unknown }>)) {
      if (answer && typeof answer === "object" && typeof answer.choice === "string") {
        answers[name] = answer.choice;
        if (typeof answer.confidence === "number") confidence[name] = answer.confidence;
        if (answer.probabilities && typeof answer.probabilities === "object") {
          probabilities[name] = Object.fromEntries(Object.entries(answer.probabilities as Record<string, unknown>).filter(([, value]) => typeof value === "number")) as Record<string, number>;
        }
      }
    }
    return { hostId, status:"ok", answers, confidence, probabilities, reason:null };
  } catch (cause) {
    const timeout = cause instanceof Error && cause.name === "TimeoutError";
    return { hostId, status:timeout ? "timeout" : "error", answers:{}, reason:timeout ? "timeout" : "api_request_failed" };
  }
};

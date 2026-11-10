import { z } from "zod";
import { ASK_KINDS, OPTIONS_ONLY_ASK_KINDS, OWNER_ASK_MAX_OPTIONS, OWNER_ASK_RENDERER_ID, OWNER_ASK_SOURCES, type AskKind, type OwnerAskPayload, type OwnerAskResponse, type OwnerAskSource } from "./owner-ask-shared";

export { ASK_KINDS, OWNER_ASK_MAX_OPTIONS, OWNER_ASK_RENDERER_ID, OWNER_ASK_SOURCES };
export type { AskKind, OwnerAskPayload, OwnerAskResponse, OwnerAskSource };

/**
 * A question to the owner as a BB pending interaction (`bb.ui.requestInput`) instead of text in a chat. Server and
 * screen share this file: what the form carries, what the owner's answer looks like and how it reads back to the
 * agent. BB's push-notifications plugin sends the interaction's title to the owner's phone, so the title is the question.
 */
const TITLE_MAX = 160;

export const ownerAskPayloadSchema = z.object({
  v: z.literal(1),
  source: z.enum(OWNER_ASK_SOURCES),
  kind: z.enum(ASK_KINDS),
  question: z.string().min(1).max(2000),
  detail: z.string().max(4000).optional(),
  options: z.array(z.object({ id: z.string().min(1).max(40), label: z.string().min(1).max(120) })).max(OWNER_ASK_MAX_OPTIONS),
  allowText: z.boolean(),
});

/** What the form submits: the option the owner picked and/or words of their own. */
export const ownerAskResponseSchema = z.object({
  choice: z.string().max(40).nullable().optional(),
  text: z.string().max(4000).optional(),
});

export type OwnerAskRequest = {
  source: OwnerAskSource;
  /** Which of the five kinds of person-facing stop this is (SMA: Five question kinds); it decides whether free text is allowed. */
  kind: AskKind;
  question: string;
  detail?: string;
  /** Short answers the owner can tap; ids are `1..n`, in this order. */
  options?: readonly string[];
};

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const firstLine = (text: string) => text.trim().split("\n", 1)[0]!.replace(/\s+/g, " ");

export function buildOwnerAskPayload(request: OwnerAskRequest): OwnerAskPayload {
  const options = (request.options ?? []).map((label) => label.trim()).filter(Boolean).slice(0, OWNER_ASK_MAX_OPTIONS)
    .map((label, index) => ({ id: String(index + 1), label: clip(label, 120) }));
  return {
    v: 1,
    source: request.source,
    kind: request.kind,
    question: clip(request.question.trim(), 2000),
    ...(request.detail?.trim() ? { detail: clip(request.detail.trim(), 4000) } : {}),
    options,
    // The kind decides free text (SMA m_q_free_text): a budget or pause stop is a pick between options; with no options
    // every kind takes words — there is nothing to pick.
    allowText: options.length ? !OPTIONS_ONLY_ASK_KINDS.has(request.kind) : true,
  };
}

/** The interaction's title: the owner's phone shows it as the push text. */
export function ownerAskTitle(payload: OwnerAskPayload): string {
  return clip(firstLine(payload.question), TITLE_MAX);
}

export type OwnerChoice = { id: string; label: string } | null;

export function resolveOwnerResponse(payload: OwnerAskPayload, response: OwnerAskResponse): { choice: OwnerChoice; text: string } {
  const choice = response.choice ? payload.options.find((option) => option.id === response.choice) ?? null : null;
  return { choice, text: (response.text ?? "").trim() };
}

/** The answer as one line for the agent or the timeline: «<option> — <words>». */
export function ownerAnswerText(answer: { choice: OwnerChoice; text: string }): string {
  return [answer.choice?.label, answer.text].filter(Boolean).join(" — ");
}

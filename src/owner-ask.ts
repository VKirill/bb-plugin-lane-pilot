import { z } from "zod";

/**
 * A question to the owner as a BB pending interaction (`bb.ui.requestInput`) instead of text in a chat. Server and
 * screen share this file: what the form carries, what the owner's answer looks like and how it reads back to the
 * agent. BB's push-notifications plugin sends the interaction's title to the owner's phone, so the title is the question.
 */
export const OWNER_ASK_RENDERER_ID = "lane-pilot-ask";
export const OWNER_ASK_SOURCES = ["pm", "gate", "repair", "council", "secret"] as const;
export type OwnerAskSource = (typeof OWNER_ASK_SOURCES)[number];

export const OWNER_ASK_MAX_OPTIONS = 6;
const TITLE_MAX = 160;

export const ownerAskPayloadSchema = z.object({
  v: z.literal(1),
  source: z.enum(OWNER_ASK_SOURCES),
  question: z.string().min(1).max(2000),
  detail: z.string().max(4000).optional(),
  options: z.array(z.object({ id: z.string().min(1).max(40), label: z.string().min(1).max(120) })).max(OWNER_ASK_MAX_OPTIONS),
  allowText: z.boolean(),
});
export type OwnerAskPayload = z.infer<typeof ownerAskPayloadSchema>;

/** What the form submits: the option the owner picked and/or words of their own. */
export const ownerAskResponseSchema = z.object({
  choice: z.string().max(40).nullable().optional(),
  text: z.string().max(4000).optional(),
});
export type OwnerAskResponse = z.infer<typeof ownerAskResponseSchema>;

export type OwnerAskRequest = {
  source: OwnerAskSource;
  question: string;
  detail?: string;
  /** Short answers the owner can tap; ids are `1..n`, in this order. */
  options?: readonly string[];
  /** Free text beside (or instead of) the options; always on when there are no options. */
  allowText?: boolean;
};

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const firstLine = (text: string) => text.trim().split("\n", 1)[0]!.replace(/\s+/g, " ");

export function buildOwnerAskPayload(request: OwnerAskRequest): OwnerAskPayload {
  const options = (request.options ?? []).map((label) => label.trim()).filter(Boolean).slice(0, OWNER_ASK_MAX_OPTIONS)
    .map((label, index) => ({ id: String(index + 1), label: clip(label, 120) }));
  return {
    v: 1,
    source: request.source,
    question: clip(request.question.trim(), 2000),
    ...(request.detail?.trim() ? { detail: clip(request.detail.trim(), 4000) } : {}),
    options,
    allowText: request.allowText === false && options.length > 0 ? false : true,
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

/**
 * What the screen needs of an owner question without zod: zod is 12% of the plugin's browser bundle, so the parts the
 * app imports live here and `owner-ask.ts` (server) keeps the zod schemas and re-exports these.
 */
export const OWNER_ASK_RENDERER_ID = "lane-pilot-ask";
export const OWNER_ASK_SOURCES = ["pm", "gate", "repair", "council", "secret"] as const;
export type OwnerAskSource = (typeof OWNER_ASK_SOURCES)[number];
export const OWNER_ASK_MAX_OPTIONS = 6;

/** The five kinds of a person-facing stop (SMA: Five question kinds): each is handled and shown by its own rule. */
export const ASK_KINDS = ["checkpoint", "budget", "pause", "decision", "worker"] as const;
export type AskKind = (typeof ASK_KINDS)[number];
/** Kinds that are a pick between options: the owner chooses, he does not write (SMA: Free text by kind). */
export const OPTIONS_ONLY_ASK_KINDS: ReadonlySet<AskKind> = new Set(["budget", "pause"]);

export type OwnerAskPayload = {
  v: 1;
  source: OwnerAskSource;
  kind: AskKind;
  question: string;
  detail?: string;
  options: Array<{ id: string; label: string }>;
  allowText: boolean;
};

/** What the form submits: the option the owner picked and/or words of their own. */
export type OwnerAskResponse = { choice?: string | null; text?: string };

const within = (value: unknown, min: number, max: number): value is string => typeof value === "string" && value.length >= min && value.length <= max;

/** The same limits as `ownerAskPayloadSchema` (unknown keys are dropped, as zod does); null when the interaction's payload is not a question of ours. */
/** A payload stored before kinds existed has none: it reads as a decision, so a question already on the owner's screen stays answerable. */
export function readOwnerAskPayload(value: unknown): OwnerAskPayload | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.v !== 1 || !(OWNER_ASK_SOURCES as readonly unknown[]).includes(row.source) || (row.kind !== undefined && !(ASK_KINDS as readonly unknown[]).includes(row.kind)) || !within(row.question, 1, 2000)) return null;
  if (row.detail !== undefined && !within(row.detail, 0, 4000)) return null;
  if (typeof row.allowText !== "boolean" || !Array.isArray(row.options) || row.options.length > OWNER_ASK_MAX_OPTIONS) return null;
  const options: OwnerAskPayload["options"] = [];
  for (const option of row.options) {
    if (!option || typeof option !== "object") return null;
    const { id, label } = option as Record<string, unknown>;
    if (!within(id, 1, 40) || !within(label, 1, 120)) return null;
    options.push({ id, label });
  }
  return { v: 1, source: row.source as OwnerAskSource, kind: (row.kind as AskKind | undefined) ?? "decision", question: row.question, ...(row.detail !== undefined ? { detail: row.detail as string } : {}), options, allowText: row.allowText };
}

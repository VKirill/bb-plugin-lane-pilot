import { z } from "zod";

/**
 * Anamnesis (A1): what Lane Pilot knows about its owner as a person. Short records with evidence and dates, never one block of
 * prose. Pure types and rules (no node imports) so that the contract, the hub and the host share them.
 */
export const KINDS = ["self", "skill", "project", "event", "person", "interest", "preference", "fact", "tool", "knowledge", "hobby"] as const;
export type Kind = (typeof KINDS)[number];

/** `public` may leave the machine (site, resume) and is only ever set by the owner; automatic writers produce `private` or `sensitive`. */
export const SENSITIVITIES = ["public", "private", "sensitive"] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];
export const SENSITIVITY_RANK: Record<Sensitivity, number> = { public: 0, private: 1, sensitive: 2 };

/**
 * candidate: a classified fragment waiting for the extractor (A4); draft: a record the owner has not looked at; confirmed: the
 * owner accepted or wrote it; rejected: the owner said it is wrong; forgotten: only ever seen in a tombstone, never stored.
 */
export const STATUSES = ["candidate", "draft", "confirmed", "rejected"] as const;
export type Status = (typeof STATUSES)[number];

/** Where evidence comes from. `manual` is the owner's own edit. */
export const SOURCES = ["bb-message", "git", "journal", "registry", "claude-memory", "bb-memory", "lp-runs", "telegram", "elba", "manual"] as const;
export type Source = (typeof SOURCES)[number];
/**
 * The owner switches source categories on and off (spec §3). The portrait is about the owner as a person, so the project data (the
 * journal, the registry, Lane Pilot's runs) is off, as are Telegram and Elba, until the owner turns them on.
 */
export const DEFAULT_SOURCES: Record<Exclude<Source, "manual">, boolean> = {
  "bb-message": true, git: true, journal: false, registry: false, "claude-memory": true, "bb-memory": true, "lp-runs": false, telegram: false, elba: false,
};

export const MAX_QUOTE = 240;
export const MAX_STATEMENT = 600;

export const evidenceSchema = z.object({
  source: z.enum(SOURCES),
  /** A pointer, not a copy: thread:seq:part, repo@sha, a path, a memory id. */
  ref: z.string().min(1).max(300),
  /** When the thing happened (the message, the commit), not when it was read. Milliseconds. */
  at: z.number().int().nonnegative(),
  quote: z.string().max(MAX_QUOTE).optional(),
}).strict();
export type Evidence = z.infer<typeof evidenceSchema>;

export const recordIdSchema = z.string().min(3).max(160).regex(/^[a-z]+:[^\s]+$/u, "id is <kind>:<slug>");

export const recordInputSchema = z.object({
  kind: z.enum(KINDS),
  /** The stable name inside the kind; the id is `<kind>:<slug(key)>`, which is what makes a second pass land on the same record. */
  key: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(160),
  statement: z.string().trim().max(MAX_STATEMENT).default(""),
  attributes: z.record(z.string(), z.unknown()).default({}),
  sensitivity: z.enum(SENSITIVITIES).optional(),
  confidence: z.number().min(0).max(1).default(0.5),
  status: z.enum(STATUSES).optional(),
  firstSeen: z.number().int().nonnegative().optional(),
  lastSeen: z.number().int().nonnegative().optional(),
  evidence: z.array(evidenceSchema).max(60).default([]),
}).strict();
export type RecordInput = z.input<typeof recordInputSchema>;
export type ParsedRecordInput = z.output<typeof recordInputSchema>;

export const recordSchema = z.object({
  id: z.string(), kind: z.enum(KINDS), title: z.string(), statement: z.string(), attributes: z.record(z.string(), z.unknown()),
  sensitivity: z.enum(SENSITIVITIES), confidence: z.number(), status: z.enum(STATUSES),
  firstSeen: z.number().nullable(), lastSeen: z.number().nullable(), manualAt: z.number(), createdAt: z.number(), updatedAt: z.number(),
  evidenceCount: z.number().int(),
}).strict();
export type AnamnesisRecord = z.infer<typeof recordSchema>;
export const recordWithEvidenceSchema = recordSchema.extend({ evidence: z.array(evidenceSchema) }).strict();
export type AnamnesisRecordFull = z.infer<typeof recordWithEvidenceSchema>;

export const historySchema = z.object({
  id: z.number().int(), recordId: z.string(), at: z.number(), actor: z.string(), action: z.string(), reason: z.string(), changes: z.record(z.string(), z.unknown()),
}).strict();
export type HistoryEntry = z.infer<typeof historySchema>;

/** The slug part of an id: lowercase, letters (any script) and digits joined by dashes. */
export function slug(text: string): string {
  const out = text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 100);
  return out || "x";
}
export const recordId = (kind: Kind, key: string): string => `${kind}:${slug(key)}`;

/* ---- text safety (ported from memory-profile) ---- */

const UNSAFE: Array<[RegExp, string]> = [
  [/[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁠﻿]/u, "control characters"],
  [/<\/?\s*(system|developer|assistant|tool)(?:\s|>)/iu, "role markup"],
  [/\b(ignore|disregard|override)\b.{0,50}\b(previous|prior|system|developer)\b/isu, "instructions to the reader"],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u, "a private key"],
  [/\b(?:sk-[a-z0-9_-]{20,}|gh[pousr]_[a-z0-9]{20,})\b/iu, "an API key"],
  [/\b[A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|API_KEY)\s*=\s*(?!\*\*\*)\S+/iu, "a credential assignment"],
];
/** The reason a text may not be stored as a statement, or null. The record is skipped, never half-written. */
export function unsafeReason(text: string): string | null {
  for (const [pattern, reason] of UNSAFE) if (pattern.test(text)) return reason;
  return null;
}

/**
 * A quote the owner can read in review, short and with credentials masked. A quote is a pointer aid, so masking
 * (instead of refusing) loses nothing the evidence ref does not still point to.
 */
export function scrubQuote(text: string, max: number = MAX_QUOTE): string {
  const masked = text
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁠﻿]/gu, " ")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "***")
    .replace(/\b(?:sk-[a-z0-9_-]{20,}|gh[pousr]_[a-z0-9]{20,}|xox[abp]-[a-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/gi, "***")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/g, "$1***")
    .replace(/\b([A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|API_KEY)\s*[=:]\s*)\S+/gi, "$1***")
    .replace(/\s+/g, " ").trim();
  return masked.length > max ? `${masked.slice(0, max - 1)}…` : masked;
}

/* ---- sensitivity floor ---- */

/** `\b` is ASCII-only in JavaScript, so word edges are spelled out: `stems` match a word start, `words` the whole word. */
const LEFT = "(?<![\\p{L}\\p{N}])", RIGHT = "(?![\\p{L}\\p{N}])";
const topic = (stems: string[], words: string[]): RegExp => new RegExp(`${LEFT}(?:(?:${stems.join("|")})|(?:${words.join("|")})${RIGHT})`, "iu");
const SENSITIVE_PATTERNS: Array<[RegExp, string]> = [
  [topic(["болезн", "диагноз", "врач", "лечени", "лечусь", "здоровь", "больниц", "таблетк", "депресс", "психотерап", "беременн", "diagnos", "therap", "medical", "surgery", "pregnan", "illness", "disease", "medication"], ["болею"]), "health"],
  [topic(["кредит", "ипотек", "зарплат", "налог", "банковск", "расчётн", "расчетн", "mortgage", "salary"], ["долг", "долги", "долгов", "доход", "доходы", "доходов", "loan", "debt"]), "finance"],
  [topic(["ребён", "ребен", "родител", "развод", "свадьб", "дочк", "дочер"], ["жена", "жены", "жене", "жену", "женой", "муж", "мужа", "мужу", "мужем", "сын", "сына", "сыну", "сыном", "дочь", "дети", "детей", "детям", "мама", "мамы", "маме", "маму", "папа", "папы", "папе", "папу", "отец", "отца", "отцу", "мать", "матери", "брат", "брата", "сестра", "сестры", "сестре", "wife", "husband", "son", "daughter", "children", "mother", "father", "divorce"]), "family"],
  [topic(["паспорт", "снилс", "passport"], ["инн", "ssn"]), "identity documents"],
];

/** Why a text must be at least `sensitive`, or null. Words only raise sensitivity; nothing automatic ever lowers it. */
export function sensitiveReason(...parts: Array<string | undefined>): string | null {
  const text = parts.filter(Boolean).join("\n");
  for (const [pattern, reason] of SENSITIVE_PATTERNS) if (pattern.test(text)) return reason;
  return null;
}

const SENSITIVE_RELATIONS = new Set(["family", "client", "friend", "partner", "doctor", "relative", "семья", "клиент", "друг"]);

/** The lowest sensitivity a record may have. People are private at least; family and clients are sensitive (spec §6). */
export function sensitivityFloor(input: { kind: Kind; title: string; statement?: string; attributes?: Record<string, unknown> }): Sensitivity {
  if (input.kind === "person") {
    const relation = String(input.attributes?.relation ?? "").toLowerCase();
    if (SENSITIVE_RELATIONS.has(relation)) return "sensitive";
  }
  if (sensitiveReason(input.title, input.statement)) return "sensitive";
  return "private";
}

export const maxSensitivity = (...values: Array<Sensitivity | undefined>): Sensitivity =>
  values.reduce<Sensitivity>((best, value) => (value && SENSITIVITY_RANK[value] > SENSITIVITY_RANK[best] ? value : best), "public");

import { z } from "zod";
import { profileSchema } from "./profile-import";
import { KINDS, SENSITIVITIES, SOURCES, STATUSES, evidenceSchema, historySchema, recordSchema, recordWithEvidenceSchema } from "./model";

/**
 * What can be asked of the anamnesis store on the owner's machine (host side), as plain data. One host method, `anamnesis`,
 * carries these, so the host contract and the PM's tool budget stay as they are. Pure zod: shared by the contract, the hub and the host.
 */
const kinds = z.array(z.enum(KINDS)).max(KINDS.length);
const statuses = z.array(z.enum(STATUSES)).max(STATUSES.length);
const source = z.enum(SOURCES);
export const editPatchSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(), statement: z.string().trim().max(600).optional(),
  attributes: z.record(z.string(), z.unknown()).optional(), sensitivity: z.enum(SENSITIVITIES).optional(),
  confidence: z.number().min(0).max(1).optional(), status: z.enum(STATUSES).optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0, "Supply at least one changed field");

export const checkpointSchema = z.object({ source, at: z.number().int().nonnegative(), detail: z.record(z.string(), z.unknown()).optional() }).strict();

/** Sources read on the owner's machine (their content never goes through the hub). */
export const HOST_SOURCES = ["git", "journal", "registry", "claude-memory", "bb-memory", "telegram", "elba"] as const;
export type HostSource = (typeof HOST_SOURCES)[number];

export const hostOps = {
  status: z.object({ op: z.literal("status") }).strict(),
  upsert: z.object({
    op: z.literal("upsert"), /** Each record is checked by the store on its own, so one bad fragment is a result and not a refused batch. */
    records: z.array(z.record(z.string(), z.unknown())).max(500), actor: z.string().min(1).max(60), reason: z.string().min(1).max(300),
    /** Advanced in the same call, after the records are stored: a failed call leaves its window to be read again. */
    checkpoint: checkpointSchema.optional(),
  }).strict(),
  add: z.object({ op: z.literal("add"), record: z.record(z.string(), z.unknown()), reason: z.string().min(1).max(300) }).strict(),
  list: z.object({ op: z.literal("list"), kinds: kinds.optional(), statuses: statuses.optional(), query: z.string().max(200).optional(), includeSensitive: z.boolean().optional(), limit: z.number().int().min(1).max(2000).optional(), offset: z.number().int().min(0).optional() }).strict(),
  get: z.object({ op: z.literal("get"), id: z.string().min(3).max(160), includeSensitive: z.boolean().optional() }).strict(),
  edit: z.object({ op: z.literal("edit"), id: z.string().min(3).max(160), patch: editPatchSchema, reason: z.string().min(1).max(300) }).strict(),
  history: z.object({ op: z.literal("history"), id: z.string().min(3).max(160), limit: z.number().int().min(1).max(500).optional() }).strict(),
  forget: z.union([
    z.object({ op: z.literal("forget"), id: z.string().min(3).max(160) }).strict(),
    z.object({ op: z.literal("forget"), all: z.literal(true) }).strict(),
    z.object({ op: z.literal("forget"), source: source.exclude(["manual"]) }).strict(),
  ]),
  /** Reads the host-side sources. `plan` counts what a `run` would store, by the same rules, and changes nothing. */
  collect: z.object({
    op: z.literal("collect"), mode: z.enum(["plan", "run"]), sources: z.array(z.enum(HOST_SOURCES)).min(1).max(HOST_SOURCES.length),
    roots: z.array(z.string().startsWith("/")).max(20).optional(), authors: z.array(z.string().min(1).max(200)).max(20).optional(),
    /** The owner's own channels for the Telegram source (A10). */
    telegramChannels: z.array(z.string().min(2).max(200)).max(10).optional(),
    since: z.number().int().nonnegative(), until: z.number().int().positive(),
  }).strict(),
  /** «Who am I in your eyes», composed on the owner's machine from the records; only the text travels. Read-only. */
  whoami: z.object({
    op: z.literal("whoami"), sections: z.array(z.enum(["identity", "skills", "projects", "timeline", "people", "interests", "preferences", "tools"])).max(8).optional(),
    detail: z.enum(["brief", "normal", "full"]).optional(), includeSensitive: z.boolean().optional(), includeDrafts: z.boolean().optional(), publicOnly: z.boolean().optional(),
    /** The review of that calendar year (skills that grew, projects, activity, milestones) instead of the sections. */
    year: z.number().int().min(2000).max(2200).optional(),
  }).strict(),
  /** The short card for the PM's context: confirmed, non-sensitive records only. Read-only. */
  card: z.object({ op: z.literal("card"), maxChars: z.number().int().min(200).max(4000).optional() }).strict(),
  /** Keeps the report of a load on the machine, for the owner's review. */
  load_report: z.object({ op: z.literal("load_report"), mode: z.enum(["plan", "run", "daily"]), report: z.record(z.string(), z.unknown()) }).strict(),
  /** Moves the card of the retired memory-profile plugin into records the owner confirmed (A9). */
  import_profile: z.object({ op: z.literal("import_profile"), profile: profileSchema }).strict(),
  sources: z.object({ op: z.literal("sources"), set: z.object({ source: source.exclude(["manual"]), enabled: z.boolean() }).strict().optional() }).strict(),
} as const;

export const anamnesisRequestSchema = z.union([
  hostOps.status, hostOps.upsert, hostOps.add, hostOps.list, hostOps.get, hostOps.edit, hostOps.history, hostOps.forget, hostOps.collect, hostOps.load_report, hostOps.whoami, hostOps.card, hostOps.import_profile, hostOps.sources,
]);
export type AnamnesisRequest = z.infer<typeof anamnesisRequestSchema>;

/* ---- answers, parsed by the hub so that a host of another version cannot hand it a different shape ---- */

export const upsertSummarySchema = z.object({
  counts: z.record(z.string(), z.number().int()),
  /** Why records were not stored, with how many: no counts of content. */
  reasons: z.record(z.string(), z.number().int()),
  ids: z.array(z.string()).max(500),
}).strict();
export type UpsertSummary = z.infer<typeof upsertSummarySchema>;

export const sourceStateSchema = z.object({ source: source.exclude(["manual"]), enabled: z.boolean(), checkpoint: z.number().nullable() }).strict();
export const countsSchema = z.object({
  records: z.number().int(), evidence: z.number().int(),
  byKind: z.record(z.string(), z.number().int()), byStatus: z.record(z.string(), z.number().int()), bySensitivity: z.record(z.string(), z.number().int()),
}).strict();
export const statusSchema = z.object({
  path: z.string(), counts: countsSchema, sources: z.array(sourceStateSchema), cutoff: z.number(),
  loads: z.array(z.object({ id: z.number().int(), at: z.number(), mode: z.string() }).strict()),
}).strict();

export const collectResponseSchema = z.object({
  mode: z.enum(["plan", "run"]),
  sources: z.array(z.object({
    source: z.enum(HOST_SOURCES), enabled: z.boolean(), items: z.number().int(), records: z.number().int(),
    outcome: z.record(z.string(), z.number().int()), reasons: z.record(z.string(), z.number().int()),
    byKind: z.record(z.string(), z.number().int()), bySensitivity: z.record(z.string(), z.number().int()),
    note: z.string().optional(), error: z.string().optional(),
  }).strict()),
}).strict();
export type CollectResponse = z.infer<typeof collectResponseSchema>;

export const responseSchemas = {
  status: statusSchema,
  upsert: upsertSummarySchema,
  add: z.object({ id: z.string().nullable(), action: z.string(), reason: z.string().nullable() }).strict(),
  list: z.object({ records: z.array(recordSchema) }).strict(),
  get: z.object({ record: recordWithEvidenceSchema.nullable() }).strict(),
  edit: z.object({ record: recordWithEvidenceSchema }).strict(),
  history: z.object({ history: z.array(historySchema) }).strict(),
  forget: z.object({ removed: z.number().int(), evidence: z.number().int().optional() }).strict(),
  collect: collectResponseSchema,
  load_report: z.object({ id: z.number().int() }).strict(),
  whoami: z.object({ text: z.string(), included: z.number().int(), hiddenSensitive: z.number().int(), drafts: z.number().int() }).strict(),
  card: z.object({ text: z.string(), chars: z.number().int(), records: z.number().int() }).strict(),
  sources: z.object({ sources: z.array(sourceStateSchema) }).strict(),
  import_profile: z.object({ imported: z.number().int(), ids: z.array(z.string()), skipped: z.array(z.string()), reasons: z.record(z.string(), z.number().int()) }).strict(),
} as const;
export type OpName = keyof typeof responseSchemas;
export type ResponseOf<O extends OpName> = z.infer<(typeof responseSchemas)[O]>;
export { evidenceSchema };

import { z } from "zod";
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
  sources: z.object({ op: z.literal("sources"), set: z.object({ source: source.exclude(["manual"]), enabled: z.boolean() }).strict().optional() }).strict(),
} as const;

export const anamnesisRequestSchema = z.union([
  hostOps.status, hostOps.upsert, hostOps.add, hostOps.list, hostOps.get, hostOps.edit, hostOps.history, hostOps.forget, hostOps.sources,
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

export const responseSchemas = {
  status: statusSchema,
  upsert: upsertSummarySchema,
  add: z.object({ id: z.string().nullable(), action: z.string(), reason: z.string().nullable() }).strict(),
  list: z.object({ records: z.array(recordSchema) }).strict(),
  get: z.object({ record: recordWithEvidenceSchema.nullable() }).strict(),
  edit: z.object({ record: recordWithEvidenceSchema }).strict(),
  history: z.object({ history: z.array(historySchema) }).strict(),
  forget: z.object({ removed: z.number().int(), evidence: z.number().int().optional() }).strict(),
  sources: z.object({ sources: z.array(sourceStateSchema) }).strict(),
} as const;
export type OpName = keyof typeof responseSchemas;
export type ResponseOf<O extends OpName> = z.infer<(typeof responseSchemas)[O]>;
export { evidenceSchema };

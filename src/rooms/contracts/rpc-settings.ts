import { z } from "zod";
import { settingValidationSchema } from "@lane-pilot/contracts";
import { PAIR_ROLE_SPECS, REASONING_LEVELS, roleSpec, type PairRoleSelectionRpc, type RoleSpec } from "@lane-pilot/models";

const REASONING_LEVEL = z.enum(REASONING_LEVELS);
const SELECTION_OUTPUT = z.object({
  ok: z.boolean(),
  conflict: z.boolean(),
  values: z.record(z.string(), z.unknown()),
  versions: z.record(z.string(), z.number().int()),
  validation: settingValidationSchema.optional(),
}).strict();

/** The contract of a `pair` role's selection RPC: the four keys of the role, saved together (packages/models/role-specs.ts). */
const pairSelection = (spec: RoleSpec) => ({
  input: z.object({
    projectId: z.string().min(1),
    sectionId: z.string().min(1).optional(),
    providerId: z.string().min(1),
    model: z.string().min(1),
    reasoningLevel: REASONING_LEVEL,
    serviceTier: z.enum(["default", "fast"]).nullable(),
    expectedVersions: z.object(Object.fromEntries(spec.keys.map((key) => [key, z.number().int().min(0)]))).strict(),
  }).strict(),
  output: SELECTION_OUTPUT,
});

/** The writer is picked for the thread it starts from, on the machine the caller named. */
const writerSelection = (spec: RoleSpec) => ({
  input: z.object({
    projectId: z.string().min(1),
    sectionId: z.string().min(1).optional(),
    threadId: z.string().min(1).nullable().optional(),
    selectedBinding: z.object({ hostId: z.string().min(1), path: z.string().min(1) }).strict().optional(),
    providerId: z.string().min(1),
    model: z.string().min(1),
    reasoningLevel: REASONING_LEVEL,
    serviceTier: z.enum(["default", "fast"]).nullable(),
    expectedVersions: z.object(Object.fromEntries(spec.keys.map((key) => [key, z.number().int().min(0)]))).strict(),
  }).strict(),
  output: SELECTION_OUTPUT,
});

type PairContracts = {
  [K in PairRoleSelectionRpc]: K extends "save_writer_selection" ? ReturnType<typeof writerSelection> : ReturnType<typeof pairSelection>;
};
const pairContracts = {
  ...Object.fromEntries(PAIR_ROLE_SPECS.filter((spec) => spec.host !== "thread").map((spec) => [spec.rpc, pairSelection(spec)])),
  save_writer_selection: writerSelection(roleSpec("writer")!),
} as unknown as PairContracts;

/** Saving settings and the model selections of every role. */
export const rpcSettings = {
  save_setting: {
    input: z.object({
      projectId: z.string().min(1),
      sectionId: z.string().min(1).optional(),
      key: z.string().min(1),
      value: z.unknown(),
      expectedVersion: z.number().int().min(0),
    }).strict(),
    output: z.object({
      ok: z.boolean(),
      conflict: z.boolean(),
      version: z.number().int(),
      value: z.unknown(),
      validation: settingValidationSchema.optional(),
    }).strict(),
  },
  reset_project_settings: {
    input: z.object({
      projectId: z.string().min(1),
      sectionId: z.string().min(1).optional(),
      keys: z.array(z.string().min(1)).min(1).max(64).refine((keys) => new Set(keys).size === keys.length),
      expectedVersions: z.record(z.string(), z.number().int().nonnegative()),
    }).strict(),
    output: z.object({
      ok: z.boolean(), conflict: z.boolean(),
      values: z.record(z.string(), z.unknown()), versions: z.record(z.string(), z.number()),
      validation: settingValidationSchema.optional(),
    }).strict(),
  },
  /**
   * The table «role -> model» for a place: the model in force for each role, where it comes from, whether this place holds a row of its own
   * (`own`, with the `version` to save or reset it against the key `role_model.<role>`), and the six models the table offers.
   */
  get_role_models: {
    input: z.object({ projectId: z.string().min(1), sectionId: z.string().min(1).optional() }).strict(),
    output: z.object({
      roles: z.array(z.object({
        role: z.string(), providerId: z.string(), model: z.string(), effort: z.string(), source: z.enum(["table", "stage", "default"]), sourceKey: z.string().nullable(),
        own: z.boolean(), version: z.number().int().min(0), defaultModel: z.string(), defaultEffort: z.string(), offered: z.boolean().nullable(),
        /** The row's fallbacks (`role_model.<role>.pool`), in order: one runs only when the models before it are spent. */
        pool: z.array(z.object({ providerId: z.string(), model: z.string(), effort: z.string().nullable() }).strict()),
      }).strict()),
      options: z.array(z.object({ id: z.string(), providerId: z.string(), label: z.string(), family: z.enum(["claude", "gpt", "google", "glm", "other"]), offered: z.boolean().nullable(), efforts: z.array(z.string()) }).strict()),
    }).strict(),
  },
  /** Every project and section that keeps its own role models, providers, efforts or writer fallbacks over the global ones. */
  list_model_overrides: {
    input: z.object({}).strict(),
    output: z.object({
      levels: z.array(z.object({
        projectId: z.string(), projectName: z.string().nullable(),
        sectionId: z.string().nullable(), sectionName: z.string().nullable(),
        keys: z.array(z.string()),
      }).strict()),
    }).strict(),
  },
  /** Gives the listed projects and sections back the global role models: removes only those model rows. */
  reset_model_overrides: {
    input: z.object({
      levels: z.array(z.object({ projectId: z.string().min(1), sectionId: z.string().min(1).nullable() }).strict()).min(1).max(1000),
    }).strict(),
    output: z.object({ ok: z.boolean(), levels: z.number().int(), removed: z.number().int() }).strict(),
  },
  save_settings: {
    input: z.object({
      projectId: z.string().min(1),
      sectionId: z.string().min(1).optional(),
      changes: z.array(z.object({
        key: z.string().min(1),
        value: z.unknown(),
        expectedVersion: z.number().int().min(0),
      }).strict()).min(1).superRefine((changes, context) => {
        const seen = new Set<string>();
        for (const change of changes) {
          if (seen.has(change.key)) {
            context.addIssue({ code: "custom", message: `duplicate setting key: ${change.key}` });
          }
          seen.add(change.key);
        }
      }),
    }).strict(),
    output: z.object({
      ok: z.boolean(),
      conflict: z.boolean(),
      values: z.record(z.string(), z.unknown()),
      versions: z.record(z.string(), z.number().int()),
      validation: settingValidationSchema.optional(),
    }).strict(),
  },
  save_writer_binding: {
    input: z.object({
      projectId: z.string().min(1),
      hostId: z.string().min(1),
      path: z.string().min(1),
    }).strict(),
    output: z.object({ ok: z.boolean() }).strict(),
  },
  ...pairContracts,
  // A writer fallback model (slot 1, 2 or 3); off: true stores an empty slot, so the default does not come back.
  save_writer_fallback_selection: {
    input:z.object({
      projectId:z.string().min(1),slot:z.union([z.literal(1),z.literal(2),z.literal(3)]),sectionId:z.string().min(1).optional(),
      off:z.boolean().optional(),providerId:z.string().min(1).optional(),model:z.string().min(1).optional(),
      reasoningLevel:z.enum(["none","low","medium","high","xhigh","ultracode","max","ultra"]).optional(),
      expectedVersions:z.record(z.string(),z.number().int().min(0)),
    }).strict(),
    output:z.object({ok:z.boolean(),conflict:z.boolean(),values:z.record(z.string(),z.unknown()),versions:z.record(z.string(),z.number().int()),validation:settingValidationSchema.optional()}).strict(),
  },
  save_council_seat_selection: {
    input:z.object({
      projectId:z.string().min(1),seat:z.enum(["product","demand","audience","skeptic","growth","ux","chair"]),providerId:z.string().min(1),model:z.string().min(1),
      sectionId:z.string().min(1).optional(),
      reasoningLevel:z.enum(["none","low","medium","high","xhigh","ultracode","max","ultra"]),
      expectedVersions:z.record(z.string(),z.number().int().min(0)),
    }).strict(),
    output:z.object({ok:z.boolean(),conflict:z.boolean(),values:z.record(z.string(),z.unknown()),versions:z.record(z.string(),z.number().int()),validation:settingValidationSchema.optional()}).strict(),
  },
};

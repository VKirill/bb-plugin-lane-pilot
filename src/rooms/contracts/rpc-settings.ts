import { z } from "zod";
import { settingValidationSchema } from "@lane-pilot/contracts";

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
  save_writer_selection: {
    input: z.object({
      projectId: z.string().min(1),
      sectionId: z.string().min(1).optional(),
      threadId: z.string().min(1).nullable().optional(),
      selectedBinding: z.object({ hostId: z.string().min(1), path: z.string().min(1) }).strict().optional(),
      providerId: z.string().min(1),
      model: z.string().min(1),
      reasoningLevel: z.enum(["none", "low", "medium", "high", "xhigh", "ultracode", "max", "ultra"]),
      serviceTier: z.enum(["default", "fast"]).nullable(),
      expectedVersions: z.object({
        "writer.provider": z.number().int().min(0),
        "writer.model": z.number().int().min(0),
        "writer.reasoning_effort": z.number().int().min(0),
        "writer.service_tier": z.number().int().min(0),
      }).strict(),
    }).strict(),
    output: z.object({
      ok: z.boolean(),
      conflict: z.boolean(),
      values: z.record(z.string(), z.unknown()),
      versions: z.record(z.string(), z.number().int()),
      validation: settingValidationSchema.optional(),
    }).strict(),
  },
  save_memory_selection: {
    input: z.object({
      projectId: z.string().min(1),
      sectionId: z.string().min(1).optional(),
      providerId: z.string().min(1),
      model: z.string().min(1),
      reasoningLevel: z.enum(["none", "low", "medium", "high", "xhigh", "ultracode", "max", "ultra"]),
      serviceTier: z.enum(["default", "fast"]).nullable(),
      expectedVersions: z.object({
        "memory.provider": z.number().int().min(0),
        "memory.model": z.number().int().min(0),
        "memory.reasoning_effort": z.number().int().min(0),
        "memory.service_tier": z.number().int().min(0),
      }).strict(),
    }).strict(),
    output: z.object({
      ok: z.boolean(),
      conflict: z.boolean(),
      values: z.record(z.string(), z.unknown()),
      versions: z.record(z.string(), z.number().int()),
      validation: settingValidationSchema.optional(),
    }).strict(),
  },
  save_night_review_selection: {
    input:z.object({
      projectId:z.string().min(1),providerId:z.string().min(1),model:z.string().min(1),
      sectionId: z.string().min(1).optional(),
      reasoningLevel:z.enum(["none","low","medium","high","xhigh","ultracode","max","ultra"]),
      serviceTier:z.enum(["default","fast"]).nullable(),
      expectedVersions:z.object({"night_review.provider":z.number().int().min(0),"night_review.model":z.number().int().min(0),"night_review.reasoning_effort":z.number().int().min(0),"night_review.service_tier":z.number().int().min(0)}).strict(),
    }).strict(),
    output:z.object({ok:z.boolean(),conflict:z.boolean(),values:z.record(z.string(),z.unknown()),versions:z.record(z.string(),z.number().int()),validation:settingValidationSchema.optional()}).strict(),
  },
  save_docs_selection: {
    input:z.object({
      projectId:z.string().min(1),providerId:z.string().min(1),model:z.string().min(1),
      sectionId: z.string().min(1).optional(),
      reasoningLevel:z.enum(["none","low","medium","high","xhigh","ultracode","max","ultra"]),
      serviceTier:z.enum(["default","fast"]).nullable(),
      expectedVersions:z.object({"docs.provider":z.number().int().min(0),"docs.model":z.number().int().min(0),"docs.reasoning_effort":z.number().int().min(0),"docs.service_tier":z.number().int().min(0)}).strict(),
    }).strict(),
    output:z.object({ok:z.boolean(),conflict:z.boolean(),values:z.record(z.string(),z.unknown()),versions:z.record(z.string(),z.number().int()),validation:settingValidationSchema.optional()}).strict(),
  },
  save_project_life_selection: {
    input:z.object({
      projectId:z.string().min(1),providerId:z.string().min(1),model:z.string().min(1),
      sectionId: z.string().min(1).optional(),
      reasoningLevel:z.enum(["none","low","medium","high","xhigh","ultracode","max","ultra"]),
      serviceTier:z.enum(["default","fast"]).nullable(),
      expectedVersions:z.object({"project_life.provider":z.number().int().min(0),"project_life.model":z.number().int().min(0),"project_life.reasoning_effort":z.number().int().min(0),"project_life.service_tier":z.number().int().min(0)}).strict(),
    }).strict(),
    output:z.object({ok:z.boolean(),conflict:z.boolean(),values:z.record(z.string(),z.unknown()),versions:z.record(z.string(),z.number().int()),validation:settingValidationSchema.optional()}).strict(),
  },
  save_pm_read_selection: {
    input:z.object({
      projectId:z.string().min(1),providerId:z.string().min(1),model:z.string().min(1),
      sectionId: z.string().min(1).optional(),
      reasoningLevel:z.enum(["none","low","medium","high","xhigh","ultracode","max","ultra"]),
      serviceTier:z.enum(["default","fast"]).nullable(),
      expectedVersions:z.object({"pm_read.provider":z.number().int().min(0),"pm_read.model":z.number().int().min(0),"pm_read.reasoning_effort":z.number().int().min(0),"pm_read.service_tier":z.number().int().min(0)}).strict(),
    }).strict(),
    output:z.object({ok:z.boolean(),conflict:z.boolean(),values:z.record(z.string(),z.unknown()),versions:z.record(z.string(),z.number().int()),validation:settingValidationSchema.optional()}).strict(),
  },
  save_onboarding_selection: {
    input:z.object({
      projectId:z.string().min(1),providerId:z.string().min(1),model:z.string().min(1),
      sectionId: z.string().min(1).optional(),
      reasoningLevel:z.enum(["none","low","medium","high","xhigh","ultracode","max","ultra"]),
      serviceTier:z.enum(["default","fast"]).nullable(),
      expectedVersions:z.object({"onboarding.provider":z.number().int().min(0),"onboarding.model":z.number().int().min(0),"onboarding.reasoning_effort":z.number().int().min(0),"onboarding.service_tier":z.number().int().min(0)}).strict(),
    }).strict(),
    output:z.object({ok:z.boolean(),conflict:z.boolean(),values:z.record(z.string(),z.unknown()),versions:z.record(z.string(),z.number().int()),validation:settingValidationSchema.optional()}).strict(),
  },
  save_plan_critique_selection: {
    input:z.object({
      projectId:z.string().min(1),providerId:z.string().min(1),model:z.string().min(1),
      sectionId: z.string().min(1).optional(),
      reasoningLevel:z.enum(["none","low","medium","high","xhigh","ultracode","max","ultra"]),
      serviceTier:z.enum(["default","fast"]).nullable(),
      expectedVersions:z.object({"plan_critique.provider":z.number().int().min(0),"plan_critique.model":z.number().int().min(0),"plan_critique.reasoning_effort":z.number().int().min(0),"plan_critique.service_tier":z.number().int().min(0)}).strict(),
    }).strict(),
    output:z.object({ok:z.boolean(),conflict:z.boolean(),values:z.record(z.string(),z.unknown()),versions:z.record(z.string(),z.number().int()),validation:settingValidationSchema.optional()}).strict(),
  },
  save_specialist_selection: {
    input:z.object({
      projectId:z.string().min(1),providerId:z.string().min(1),model:z.string().min(1),
      sectionId: z.string().min(1).optional(),
      reasoningLevel:z.enum(["none","low","medium","high","xhigh","ultracode","max","ultra"]),
      serviceTier:z.enum(["default","fast"]).nullable(),
      expectedVersions:z.object({"specialist.provider":z.number().int().min(0),"specialist.model":z.number().int().min(0),"specialist.reasoning_effort":z.number().int().min(0),"specialist.service_tier":z.number().int().min(0)}).strict(),
    }).strict(),
    output:z.object({ok:z.boolean(),conflict:z.boolean(),values:z.record(z.string(),z.unknown()),versions:z.record(z.string(),z.number().int()),validation:settingValidationSchema.optional()}).strict(),
  },
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
      sectionId: z.string().min(1).optional(),
      reasoningLevel:z.enum(["none","low","medium","high","xhigh","ultracode","max","ultra"]),
      expectedVersions:z.record(z.string(),z.number().int().min(0)),
    }).strict(),
    output:z.object({ok:z.boolean(),conflict:z.boolean(),values:z.record(z.string(),z.unknown()),versions:z.record(z.string(),z.number().int()),validation:settingValidationSchema.optional()}).strict(),
  },
  save_code_critique_selection: {
    input:z.object({
      projectId:z.string().min(1),providerId:z.string().min(1),model:z.string().min(1),
      sectionId: z.string().min(1).optional(),
      reasoningLevel:z.enum(["none","low","medium","high","xhigh","ultracode","max","ultra"]),
      serviceTier:z.enum(["default","fast"]).nullable(),
      expectedVersions:z.object({"code_critique.provider":z.number().int().min(0),"code_critique.model":z.number().int().min(0),"code_critique.reasoning_effort":z.number().int().min(0),"code_critique.service_tier":z.number().int().min(0)}).strict(),
    }).strict(),
    output:z.object({ok:z.boolean(),conflict:z.boolean(),values:z.record(z.string(),z.unknown()),versions:z.record(z.string(),z.number().int()),validation:settingValidationSchema.optional()}).strict(),
  },
};

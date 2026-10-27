import { z } from "zod";
import { scheduleRpcContract } from "../schedule";
import { inventoryGroupSchema } from "@lane-pilot/contracts";

/**
 * One agent of the pickable list (`listedAgentProfiles`): `id` and `description` (the label) were there first; the rest only adds.
 * `kind`: coordinator is the Lane Pilot PM, internal is a session Lane Pilot runs itself (not for the owner to pick), specialist is every other agent.
 */
export const pickableAgentSchema = z.object({
  id: z.string(),
  description: z.string(),
  displayName: z.string().optional(),
  summary: z.string().optional(),
  kind: z.enum(["coordinator", "specialist", "internal"]).optional(),
  custom: z.boolean().optional(),
}).strict();

/** The settings view of an agent: the pickable fields plus the whole profile. */
export const agentListItemSchema = pickableAgentSchema.extend({
  prompt: z.string(),
  sourceHash: z.string(),
  sourceVersion: z.string(),
  edited: z.boolean(),
  tools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  mcpServers: z.array(z.string()).optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
}).strict();

const agentNames = z.array(z.string().min(1)).max(64);
const agentOutcome = z.object({ ok: z.boolean(), id: z.string(), error: z.string().optional(), detail: z.string().optional() }).strict();

/** Preferences, projects and sections, global settings and agent profiles. */
export const rpcShell = {
  ...scheduleRpcContract,
  get_preferences: {
    input: z.object({ suggestedLocale: z.enum(["en", "ru"]) }).strict(),
    output: z.object({ locale: z.enum(["en", "ru"]), preference: z.enum(["auto", "en", "ru"]), lastProjectId: z.string().nullable() }).strict(),
  },
  set_locale: {
    input: z.object({ locale: z.enum(["auto", "en", "ru"]), suggestedLocale: z.enum(["en", "ru"]) }).strict(),
    output: z.object({ locale: z.enum(["en", "ru"]), preference: z.enum(["auto", "en", "ru"]) }).strict(),
  },
  remember_project: {
    input: z.object({ projectId: z.string().min(1) }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  list_sections: {
    input: z.object({ projectId: z.string().min(1) }).strict(),
    output: z.object({
      sections: z.array(z.object({ id: z.string(), parentId: z.string().nullable(), name: z.string(), path: z.string(), kind: z.enum(["folder", "group"]) }).strict()),
    }).strict(),
  },
  list_projects: {
    input: z.object({}).strict(),
    output: z.object({
      projects: z.array(z.object({ id: z.string(), name: z.string(), kind: z.enum(["personal", "standard"]).optional() }).strict()),
      lastProjectId: z.string().nullable(),
    }).strict(),
  },
  get_globals: {
    input: z.object({}).strict(),
    output: z.object({
      defaults: z.object({
        writerProviderId: z.string().optional(),
        writerModel: z.string().optional(),
        writerReasoningEffort: z.string().optional(),
        helperPlacement: z.enum(["plugin", "project_tree"]).optional(),
        qaHostId: z.string().optional(),
      }).strict(),
      revision: z.number().int().nonnegative(),
      agents: z.array(agentListItemSchema),
      hosts: z.array(z.object({
        id: z.string(), name: z.string(), status: z.string(), connected: z.boolean(),
      }).strict()).optional(),
      requiredSessionPolicy: z.enum(["required", "none"]).optional(),
    }).strict(),
  },
  get_agent_inventory: {
    input: z.object({
      projectId: z.string().nullable(),
      hostId: z.string().nullable(),
    }).strict(),
    output: z.object({
      skills: inventoryGroupSchema,
      mcpServers: inventoryGroupSchema,
      tools: inventoryGroupSchema,
      disallowedTools: inventoryGroupSchema,
    }).strict(),
  },
  save_globals: {
    input: z.object({
      defaults: z.object({
        writerProviderId: z.string().optional(),
        writerModel: z.string().optional(),
        writerReasoningEffort: z.string().optional(),
        helperPlacement: z.enum(["plugin", "project_tree"]).optional(),
        qaHostId: z.string().optional(),
      }).strict(),
      expectedRevision: z.number().int().nonnegative(),
    }).strict(),
    output: z.object({
      ok: z.boolean(),
      revision: z.number().int().nonnegative(),
      defaults: z.record(z.string(), z.unknown()),
    }).strict(),
  },
  save_agent_profile: {
    input: z.object({
      id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
      prompt: z.string().min(1).max(32_000),
      description: z.string().min(1).max(400).optional(),
      expectedSourceHash: z.union([z.literal(""), z.string().regex(/^[a-f0-9]{64}$/)]),
      tools: z.array(z.string().min(1)).max(64).optional(),
      disallowedTools: z.array(z.string().min(1)).max(64).optional(),
      skills: z.array(z.string().min(1)).max(64).optional(),
      mcpServers: z.array(z.string().min(1)).max(64).optional(),
      resourceModes: z.object({
        tools: z.enum(["inherit", "none", "selected"]).optional(),
        disallowedTools: z.enum(["inherit", "none", "selected"]).optional(),
        skills: z.enum(["inherit", "none", "selected"]).optional(),
        mcpServers: z.enum(["inherit", "none", "selected"]).optional(),
      }).strict().optional(),
    }).strict(),
    output: z.object({ ok: z.boolean(), id: z.string(), sourceHash: z.string() }).strict(),
  },
  list_agents: {
    input: z.object({ custom: z.boolean().optional() }).strict(),
    output: z.object({ agents: z.array(agentListItemSchema) }).strict(),
  },
  create_agent: {
    input: z.object({
      id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
      displayName: z.string().min(1).max(120),
      description: z.string().max(400).optional(),
      prompt: z.string().min(1).max(32_000),
      tools: agentNames.optional(),
      disallowedTools: agentNames.optional(),
      skills: agentNames.optional(),
      mcpServers: agentNames.optional(),
      model: z.string().min(1).max(100).optional(),
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
    }).strict(),
    output: agentOutcome,
  },
  update_agent: {
    input: z.object({
      id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
      displayName: z.string().min(1).max(120).optional(),
      description: z.string().max(400).optional(),
      prompt: z.string().min(1).max(32_000).optional(),
      tools: agentNames.optional(),
      disallowedTools: agentNames.optional(),
      skills: agentNames.optional(),
      mcpServers: agentNames.optional(),
      model: z.string().min(1).max(100).nullable().optional(),
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).nullable().optional(),
    }).strict(),
    output: agentOutcome,
  },
  delete_agent: {
    input: z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/) }).strict(),
    output: agentOutcome,
  },
};

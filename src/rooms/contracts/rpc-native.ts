import { z } from "zod";

/** Activating the PM, the native session, helper threads. */
export const rpcNative = {
  finish_run: {
    input: z.object({ projectId: z.string().min(1), runId: z.string().min(1) }).strict(),
    output: z.object({ projectId: z.string(), finishedRunIds: z.array(z.string()), closed: z.boolean() }).strict(),
  },
  activate_pm: {
    input: z.object({
      projectId: z.string().min(1),
      sourceThreadId: z.string().nullable(),
      agentId: z.string().nullable().optional(),
      snapshot: z.object({
        status: z.literal("ready"),
        scope: z.object({ kind: z.literal("new-thread"), projectId: z.string().nullable() }).strict(),
        projectId: z.string().min(1),
        providerId: z.string().min(1),
        model: z.string().min(1),
        reasoningLevel: z.string().min(1),
        serviceTier: z.string().optional(),
        environment: z.union([
          z.object({
            kind: z.literal("existing"),
            type: z.literal("reuse"),
            environmentId: z.string().min(1),
            hostId: z.string().min(1).optional(),
            path: z.string().min(1).optional(),
          }).strict(),
          z.object({
            kind: z.literal("existing"),
            type: z.literal("host"),
            workspaceType: z.enum(["personal", "unmanaged", "managed-worktree"]),
            hostId: z.string().min(1).optional(),
            path: z.string().min(1).optional(),
          }).strict(),
          z.object({ kind: z.literal("existing"), type: z.literal("project-default") }).strict(),
          z.object({
            kind: z.literal("provisioning"),
            type: z.literal("provider"),
            environmentProviderId: z.string().min(1),
            machine: z.union([
              z.object({ type: z.literal("existing"), hostId: z.string().min(1) }).strict(),
              z.object({ type: z.literal("new"), machineProviderId: z.string().min(1) }).strict(),
            ]).optional(),
          }).strict(),
        ]),
        environmentRequest: z.union([
          z.object({ type: z.literal("reuse"), environmentId: z.string().min(1) }).strict(),
          z.object({
            type: z.literal("host"),
            hostId: z.string().min(1).optional(),
            workspace: z.union([
              z.object({ type: z.literal("personal") }).passthrough(),
              z.object({ type: z.literal("unmanaged"), path: z.string().nullable().optional() }).passthrough(),
              z.object({ type: z.literal("managed-worktree") }).passthrough(),
            ]),
          }).passthrough(),
          z.object({ type: z.literal("project-default") }).strict(),
          z.object({
            type: z.literal("provider"),
            environmentProviderId: z.string().min(1),
            machine: z.union([
              z.object({ type: z.literal("existing"), hostId: z.string().min(1) }).passthrough(),
              z.object({ type: z.literal("new"), machineProviderId: z.string().min(1) }).passthrough(),
            ]).optional(),
            inputs: z.unknown().optional(),
          }).passthrough(),
        ]),
        environmentProvenance: z.object({
          projectId: z.string().min(1),
          sectionId: z.null(),
          projectSourceId: z.string().min(1).optional(),
          hostId: z.string().min(1).optional(),
          path: z.string().min(1).optional(),
        }).strict(),
      }).strict().optional(),
    }).strict(),
    /** bookkeepingExcluded: the lines activation just added to the project's .git/info/exclude; absent when none were missing. */
    output: z.object({ threadId: z.string().min(1), runId: z.string().min(1), bookkeepingExcluded: z.array(z.string()).optional() }).strict(),
  },
  activation_context: {
    input: z.object({
      projectId: z.string().nullable(),
      threadId: z.string().nullable(),
    }).strict(),
    output: z.object({
      projectId: z.string().nullable(),
      projects: z.array(z.object({ id: z.string(), name: z.string() }).strict()),
      bindingStatus: z.enum(["resolved", "ambiguous", "setup_required", "offline", "catalog_unavailable"]).nullable(),
      compiledMainAgent: z.enum(["supported", "none"]),
      mainAgents: z.array(z.object({ id: z.string(), description: z.string() }).strict()),
      writer: z.object({
        providerId: z.string().nullable(),
        model: z.string().nullable(),
        reasoningEffort: z.string().nullable(),
      }).strict(),
      liveRun: z.object({ threadId: z.string(), runId: z.string() }).strict().nullable(),
      pluginRole: z.string().nullable(),
      threadStatus: z.string().nullable(),
      /** The project's main agent, when one is chosen and still listed; new chats enable Lane Pilot with it. */
      mainAgent: z.string().nullable().optional(),
      requiredSessionPolicy: z.enum(["required", "none"]),
    }).strict(),
  },
  native_install_start: {
    input: z.object({ hostId: z.string().min(1) }).strict(),
    output: z.object({ started: z.boolean() }).strict(),
  },
  native_install_status: {
    input: z.object({ hostId: z.string().min(1) }).strict(),
    output: z.object({ status: z.string(), error: z.string().nullable() }).strict(),
  },
  prepare_native_session: {
    input: z.object({
      projectId: z.string().min(1),
      agentId: z.string().min(1).max(200),
    }).strict(),
    output: z.object({
      token: z.string().uuid(),
      label: z.string().min(1),
      agentId: z.string().min(1),
      profileMode: z.enum(["installed", "session-override"]),
      cliAgentsCollision: z.enum(["pending", "thread", "mention"]).nullable(),
    }).strict(),
  },
  list_helper_threads: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({
      threads: z.array(z.object({
        id: z.string(),
        title: z.string(),
        status: z.string(),
        role: z.string(),
        detail: z.string().nullable(),
        phase: z.string().nullable().optional(),
      }).strict()),
      queued: z.array(z.string()).default([]),
    }).strict(),
  },
};

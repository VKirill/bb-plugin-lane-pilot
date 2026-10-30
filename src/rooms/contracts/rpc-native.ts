import { z } from "zod";
import { pickableAgentSchema } from "./rpc-shell";

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
      mainAgents: z.array(pickableAgentSchema),
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
  remove_claude_lane_leftovers: {
    input: z.object({ hostId: z.string().min(1), apply: z.boolean().optional() }).strict(),
    output: z.object({
      apply: z.boolean(),
      changed: z.boolean(),
      settings: z.array(z.string()),
      codex: z.array(z.string()),
      moved: z.array(z.string()),
      backupDir: z.string().nullable(),
    }).strict(),
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
      environment: z.object({
        type: z.literal("host"),
        hostId: z.string(),
        workspace: z.object({ type: z.literal("unmanaged"), path: z.string() }).strict(),
      }).strict().nullable(),
      placementNote: z.string().nullable(),
    }).strict(),
  },
  /** Whether an existing chat can change its agent, and which agent it runs (or will on its next message). */
  chat_agent_state: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({
      projectId: z.string(),
      eligible: z.boolean(),
      reason: z.enum(["helper", "provider", "lane_started", "specialist_run"]).nullable(),
      current: z.object({ agentId: z.string(), description: z.string().min(1), pending: z.boolean() }).strict().nullable(),
    }).strict(),
  },
  /** Changes the agent of an existing chat from its next message; `agentId: null` makes the chat plain again. */
  switch_chat_agent: {
    input: z.object({ threadId: z.string().min(1), agentId: z.string().min(1).max(200).nullable() }).strict(),
    output: z.object({ agentId: z.string().nullable(), description: z.string().nullable() }).strict(),
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
      /** The open run's unfinished tasks and what each waits for (src/rooms/runs/server/task-graph.ts). */
      graph: z.object({
        nodes: z.array(z.object({ id: z.string(), title: z.string(), state: z.enum(["running", "waiting", "queued", "blocked"]), threadId: z.string().nullable() }).strict()),
        edges: z.array(z.object({ from: z.string(), to: z.string(), kind: z.enum(["depends", "files", "folder", "question"]) }).strict()),
      }).strict().optional(),
    }).strict(),
  },
  /** Role labels for sidebar row marks (`experimental_threadRowMetadata`): threadId → its LP role, only for LP threads. */
  helper_thread_labels: {
    input: z.object({ threadIds: z.array(z.string().min(1)).min(1).max(200) }).strict(),
    output: z.object({ labels: z.record(z.string(), z.string()) }).strict(),
  },
};

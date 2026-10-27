import { writerExecutionSelection } from "@lane-pilot/models";
import { redactKnown } from "@lane-pilot/kit";
import { HELPER_ROLES, mentionContext, type HelperRole } from "../../native-agent";
import { storeNativeSelection } from "../../native-agent/server";
import { requireHelperSpawn, requiredPolicyField } from "../../runs/server";
import { fullAccessSpawn, stringAt } from "../../core/server";
import { detectRepoEdits, gitRepoStatus } from "../../verification/server";
import type { ServerCore } from "../../core/server";

const AGENT_MODEL = "claude-opus-5-5";
const AGENT_REASONING = "high";

/** The text of a thread's output (what writer/server `outputText` reads; not imported from there, writer/server imports this room back). */
const reportText = (raw: unknown): string => (typeof raw === "string" ? raw : ["text", "output", "lastAssistantText", "content"].map((key) => stringAt(raw, key)).find((found) => typeof found === "string") ?? JSON.stringify(raw));

export type ScheduledAgentStart = {
  projectId: string; runId: string; pmThreadId: string; agentId: string;
  /** Everything after the profile marker: the standing task, the previous runs, the memory, the outcome format. */
  brief: string; title: string; spawnId: string;
  model?: string | undefined; reasoning?: string | undefined; serviceTier?: "default" | "fast" | undefined;
  metadata?: Record<string, unknown> | undefined;
};

/**
 * A named agent started by a schedule, as itself: the same stored profile selection a chat started with that agent from the composer
 * gets (prompt, skills, MCP servers), in a hidden thread with no parent chat (a parent would be woken by its end: scheduled errands
 * learned that on 2026-10-19). The thread belongs to the PM's run, like a specialist's, so it opens no run of its own.
 */
export function mountScheduledAgents(ctx: ServerCore) {
  const { bb, db, host } = ctx;
  const snapshots = new Map<string, { hostId: string; cwd: string; before: Set<string> }>();

  async function start(input: ScheduledAgentStart): Promise<{ threadId: string }> {
    let stored: Awaited<ReturnType<typeof storeNativeSelection>>;
    try {
      stored = await storeNativeSelection(ctx, { projectId: input.projectId, agentId: input.agentId, parentRunId: input.runId });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(/^Unknown Lane Pilot profile/u.test(message) ? `agent_unknown: there is no agent "${input.agentId}" any more (renamed or deleted); change the schedule's agentId` : `agent_profile: ${message}`);
    }
    const pm = await bb.sdk.threads.get({ threadId: input.pmThreadId });
    const environmentId = stringAt(pm, "environmentId");
    if (!environmentId) throw new Error("scheduled_agent_needs_pm_environment");
    const envObj = await bb.sdk.environments.get({ environmentId }).catch(() => null);
    const checkoutPath = stringAt(envObj, "path") ?? "";
    const checkoutHostId = stringAt(envObj, "hostId") ?? "";
    const beforeStatus = checkoutPath && checkoutHostId ? await gitRepoStatus(host, checkoutHostId, checkoutPath) : null;
    const helperPolicy = requireHelperSpawn({ bb, db, projectId: input.projectId, runId: input.runId });
    const pmSection = stringAt(pm, "sectionId");
    // An agent with a role profile (the specialists) loads only what that role needs; any other runs on BB's ordinary context plus its own profile.
    const role = (HELPER_ROLES as readonly string[]).includes(`specialist:${input.agentId}`) ? `specialist:${input.agentId}` as HelperRole : undefined;
    const spawned = await fullAccessSpawn(bb, {
      visibility: "hidden", projectId: input.projectId, title: `Lane Pilot scheduled agent: ${input.title}`.slice(0, 120), ...(pmSection ? { sectionId: pmSection } : {}),
      ...requiredPolicyField(bb, helperPolicy, "claude-code", role),
      ...writerExecutionSelection("claude-code", input.model ?? AGENT_MODEL, input.reasoning ?? AGENT_REASONING, input.serviceTier ?? "default"),
      prompt: `${mentionContext(stored.selection)}\n\n${input.brief}`,
      environment: { type: "reuse", environmentId },
      pluginMetadata: { role: "specialist", specialist: input.agentId, spawnId: input.spawnId, lanePilotRunId: input.runId, helperMode: helperPolicy.mode, ...input.metadata },
    } as Parameters<typeof fullAccessSpawn>[1]);
    const threadId = stringAt(spawned, "id");
    if (!threadId) throw new Error("scheduled_agent_thread_id_missing");
    if (beforeStatus) snapshots.set(threadId, { hostId: checkoutHostId, cwd: checkoutPath, before: beforeStatus });
    return { threadId };
  }

  /** The report of an ended thread: its text, or `blocked` when the agent changed repository files (it may write under .agents/ only) or the output guard held the text. */
  async function completedReport(threadId: string, projectId = "-"): Promise<{ state: "done" | "blocked"; reason?: string; output: string; files?: string[] }> {
    const snapshot = snapshots.get(threadId);
    let edited: string[] = [];
    if (snapshot) {
      snapshots.delete(threadId);
      const after = await gitRepoStatus(host, snapshot.hostId, snapshot.cwd);
      edited = after ? detectRepoEdits(snapshot.before, after, (file) => file.startsWith(".agents/") || file === ".agents" || file.startsWith(".bb/chats/")) : [];
    }
    const raw = (await bb.sdk.threads.output({ threadId })).output;
    const text = reportText(raw);
    const guarded = ctx.outputGuard ? await ctx.outputGuard({ kind: "errand", text, projectId, subject: threadId }) : null;
    if (guarded?.blocked) return { state: "blocked", reason: `output_guard_blocked:${guarded.reason}`, output: guarded.text };
    const output = guarded ? guarded.text : redactKnown(text);
    return edited.length ? { state: "blocked", reason: "repo_edited", files: edited, output } : { state: "done", output };
  }

  return { start, completedReport };
}
export type ScheduledAgentsApi = ReturnType<typeof mountScheduledAgents>;

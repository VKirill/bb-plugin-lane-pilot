import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { rpcContract } from "../contracts";
import { writerExecutionSelection } from "../jev-reasoning";
import { mentionContext } from "../native-dispatch";
import { WORKFLOW_ARCHITECT_ID, WORKFLOW_ARCHITECT_NAME } from "../workflow-architect";
import { createDraftStore } from "../workflow/draft-store";
import type { ServerCore } from "./core";
import { storeNativeSelection } from "./native-profile";
import { fullAccessSpawn } from "./pm-spawn";
import { CONFIG_KEY, SELF_REPAIR_DEFAULTS } from "./self-repair";
import type { Services } from "./services";
import { stringAt } from "./values";

/** The architect always runs on these, whatever the project or the owner's remembered choice says. */
export const ARCHITECT_EXECUTION = { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" } as const;

/** Threads in these states are over: a new button press starts a new architect chat instead of returning them. */
const DEAD_STATUSES = new Set(["error", "stopped"]);

type OpeningPart = { type: "text"; text: string; mentions: []; visibility?: "agent-only" };

/**
 * The architect's first message. The visible part carries the profile token (the dispatch hook turns the thread into a real
 * architect session from it, as for the composer's «Enable Lane Pilot») and one line the owner can read; the brief is
 * `agent-only`, so the chat opens with the architect's own greeting. The visible part comes first: a message that opens
 * with an agent-only part reads to BB as a seed.
 */
export function architectOpening(input: { marker: string; projectId: string; projectName: string | null; draft: { id: string; name: string } | null }): OpeningPart[] {
  const part = (text: string, hide: boolean): OpeningPart => ({ type: "text", text, mentions: [], ...(hide ? { visibility: "agent-only" as const } : {}) });
  const brief = [
    `The owner pressed «Собрать с архитектором» in the Workflows tab of Lane Pilot (project ${input.projectName ? `${input.projectName}, ` : ""}${input.projectId}). Drafts you create belong to this project; offer scope global (the owner's library) unless the chain is only for this project.`,
    ...(input.draft
      ? [
        `The owner wants to continue the draft ${input.draft.id} («${input.draft.name}»). Read it first with lane_pilot_workflow_draft_get {draftId: "${input.draft.id}", history: true}, then open the conversation in Russian in two or three sentences: what the chain does now, what is missing (validator problems, tests) and the question of what to change. Patch that draft; do not start another one unless the owner asks.`,
      ]
      : [
        "Open the conversation yourself, in Russian: a short greeting (one or two sentences) and one question about the chain the owner wants to build - the goal in a sentence, what starts it, where the information comes from, what comes out and where it goes. Do not call tools before the owner answers.",
      ]),
  ].join("\n\n");
  return [
    part(`${input.marker}\n\nСобрать цепочку с архитектором.`, false),
    part(brief, true),
  ];
}

/**
 * `workflow_architect_start`: a chat thread with the Workflow architect already active, spawned by the server so the
 * Workflows tab can open it in the side panel. Where it runs: the project's own source folder on its machine, the project
 * being `projectId`, else the draft's, else the Lane Pilot project of the hub (self-repair's `projectId`, where Lane Pilot's
 * own repository lives), so the button works with no setting at all.
 */
export function architectStartRpc(ctx: ServerCore, services: Pick<Services, "docsPlaces">) {
  const { bb, db } = ctx;
  const drafts = createDraftStore(db);
  const inflight = new Map<string, Promise<{ threadId: string; projectId: string; reused: boolean }>>();

  const keyOf = (projectId: string, draftId: string | null) => `architect-thread:${projectId}:${draftId ?? "-"}`;

  async function liveThread(key: string, projectId: string): Promise<string | null> {
    const threadId = await bb.storage.kv.get<string>(key).catch(() => null);
    if (typeof threadId !== "string" || !threadId) return null;
    const thread = await bb.sdk.threads.get({ threadId }).catch(() => null) as { archivedAt?: unknown } | null;
    if (!thread || thread.archivedAt) return null;
    if (stringAt(thread, "projectId") !== projectId || DEAD_STATUSES.has(stringAt(thread, "status") ?? "")) return null;
    return threadId;
  }

  async function lanePilotProjectId(): Promise<string> {
    const raw = await bb.storage.kv.get(CONFIG_KEY).catch(() => null) as { projectId?: unknown } | null;
    return typeof raw?.projectId === "string" && raw.projectId ? raw.projectId : SELF_REPAIR_DEFAULTS.projectId;
  }

  async function placeThread(threadId: string, projectId: string, folderId: string): Promise<void> {
    try {
      await bb.sdk.plugins.callRpc({ pluginId: "project-folders", method: "thread_place", input: { threadId, projectId, folderId }, outputSchema: z.object({ ok: z.literal(true) }) });
    } catch (cause) {
      bb.log.warn(`architect: could not file @thread:${threadId} in section ${folderId}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  async function start(input: { projectId?: string; sectionId?: string; draftId?: string }) {
    const draft = input.draftId ? drafts.get(input.draftId) : null;
    if (input.draftId && !draft) throw new Error(`draft ${input.draftId} does not exist`);
    if (draft && input.projectId && draft.projectId !== input.projectId) throw new Error(`draft ${draft.id} belongs to another project`);
    const projectId = input.projectId ?? draft?.projectId ?? await lanePilotProjectId();
    const key = keyOf(projectId, draft?.id ?? null);
    const reusedId = await liveThread(key, projectId);
    if (reusedId) return { threadId: reusedId, projectId, reused: true };

    const places = await services.docsPlaces(projectId).catch(() => []);
    const root = places.find((place) => place.scopes.length === 0) ?? places[0];
    if (!root) throw new Error(`project ${projectId} has no source folder on a machine: add one to the project in BB, then press the button again`);

    const { selection } = await storeNativeSelection(ctx, { projectId, agentId: WORKFLOW_ARCHITECT_ID });
    const described = await bb.sdk.projects.get({ projectId }).catch(() => null) as { name?: unknown } | null;
    const spawned = await fullAccessSpawn(bb, {
      projectId,
      ...writerExecutionSelection(ARCHITECT_EXECUTION.providerId, ARCHITECT_EXECUTION.model, ARCHITECT_EXECUTION.reasoningLevel, "default"),
      title: WORKFLOW_ARCHITECT_NAME.ru,
      input: architectOpening({ marker: mentionContext(selection), projectId, projectName: typeof described?.name === "string" ? described.name : null,
        draft: draft ? { id: draft.id, name: String((draft.definition.name as { ru?: unknown; en?: unknown } | undefined)?.ru ?? (draft.definition.name as { en?: unknown } | undefined)?.en ?? draft.workflowId ?? draft.id) } : null }),
      environment: { type: "host", hostId: root.hostId, workspace: { type: "unmanaged", path: root.path } },
      visibility: "visible",
      pluginMetadata: { role: "workflow-architect", spawnId: `architect:${projectId}:${draft?.id ?? "new"}`, architectProjectId: projectId, ...(draft ? { architectDraftId: draft.id } : {}) },
    } as unknown as Parameters<typeof fullAccessSpawn>[1]);
    const threadId = stringAt(spawned, "id");
    if (!threadId) throw new Error("threads.spawn returned no architect thread id");
    await bb.storage.kv.set(key, threadId);
    if (input.sectionId) await placeThread(threadId, projectId, input.sectionId);
    return { threadId, projectId, reused: false };
  }

  return {
    // One start per project and draft at a time: a double click joins the call in flight instead of spawning a second chat.
    workflow_architect_start: ({ projectId, sectionId, draftId }) => {
      const pending = inflight.get(`${projectId ?? ""}:${draftId ?? ""}`);
      if (pending) return pending;
      const run = start({ projectId, sectionId, draftId }).finally(() => inflight.delete(`${projectId ?? ""}:${draftId ?? ""}`));
      inflight.set(`${projectId ?? ""}:${draftId ?? ""}`, run);
      return run;
    },
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "workflow_architect_start">;
}

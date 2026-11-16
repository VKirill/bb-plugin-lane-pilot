import { z } from "zod";
import { serviceMessageText, DEFAULT_NATIVE_AGENT, type ChildPmRequest } from "../../contracts";
import { defaultModelIn } from "@lane-pilot/models";
import { stringAt } from "@lane-pilot/kit";
import type { ServerCore } from "../../contracts/server";
import { fullAccessSpawn } from "../../platform/server";
import { mentionContext } from "../native-dispatch";
import { storeNativeSelection } from "./native-profile";

/** A native PM owns its run. Starting one must not claim the project's legacy activation or borrow the parent's checkout. */
export async function startChildPm(ctx: ServerCore, input: ChildPmRequest): Promise<{ threadId: string }> {
  const { bb } = ctx;
  const project = await bb.sdk.projects.get({ projectId: input.projectId });
  if (!project || stringAt(project, "id") !== input.projectId) throw new Error("target project is unavailable");
  const sections = await ctx.listProjectSections(input.projectId);
  const section = input.sectionId ? sections.find((row) => row.id === input.sectionId && row.projectId === input.projectId) : undefined;
  if (input.sectionId && !section) throw new Error(`section ${input.sectionId} is not available in project ${input.projectId}`);
  if (section?.kind === "group") throw new Error("a group holds sections, not chats; choose a folder section inside it");
  type Place = { hostId: string; path: string; isDefault?: boolean };
  const sources = (project as { sources?: Place[] }).sources ?? [];
  const candidates = section?.kind === "folder"
    ? (section.paths.length ? section.paths : [{ hostId: section.hostId, path: section.path }])
    : sources;
  const places: Place[] = [];
  for (const row of candidates) {
    if (row.hostId && row.path && !places.some((place) => place.hostId === row.hostId && place.path === row.path)) places.push(row);
  }
  const selected = input.hostId || input.path
    ? places.filter((place) => place.hostId === input.hostId && place.path === input.path)
    : places.length === 1 ? places : places.filter((place) => place.isDefault);
  if (selected.length !== 1) throw new Error(`select a targetHostId/targetPath from this destination's folders: ${JSON.stringify(places)}`);
  const place = selected[0]!;

  // Native profiles are currently supported on Claude Code. Keep the parent's Claude selection,
  // otherwise use the destination host's advertised default; never silently start an unbound agent.
  const execution = await bb.sdk.threads.defaultExecutionOptions({ threadId: input.parentThreadId });
  const providerId = "claude-code";
  const model = stringAt(execution, "providerId") === providerId ? stringAt(execution, "model") : null;
  const chosenModel = model ?? defaultModelIn((await bb.sdk.providers.models({ providerId, hostId: place.hostId })).models);
  if (!chosenModel) throw new Error(`no Claude Code default model is available on ${place.hostId}`);
  const { selection } = await storeNativeSelection(ctx, { projectId: input.projectId, agentId: DEFAULT_NATIVE_AGENT });
  const spawned = await fullAccessSpawn(bb, {
    projectId: input.projectId, parentThreadId: input.parentThreadId, senderThreadId: input.parentThreadId,
    providerId, model: chosenModel, title: input.title, visibility: "visible",
    environment: { type: "host", hostId: place.hostId, workspace: { type: "unmanaged", path: place.path } },
    input: [
      { type: "text", text: serviceMessageText("Child Pilot initialization. Wait for an assignment from the parent thread. Do not start work or activate other Pilots."), mentions: [] },
      { type: "text", text: mentionContext(selection), mentions: [], visibility: "agent-only" },
    ],
    pluginMetadata: { role: "pm", spawnId: `handoff:${input.handoffId}`, parentPmThreadId: input.parentThreadId },
  });
  const threadId = stringAt(spawned, "id");
  if (!threadId) throw new Error("threads.spawn returned no child Pilot thread id");
  try {
    // Project Folders ids are not BB core thread-section ids. Place before delivering any work.
    if (input.sectionId) await bb.sdk.plugins.callRpc({
      pluginId: "project-folders", method: "thread_place",
      input: { threadId, projectId: input.projectId, folderId: input.sectionId }, outputSchema: z.object({ ok: z.literal(true) }),
    });
  } catch (cause) {
    throw new Error(`child Pilot @thread:${threadId} exists; placement failed: ${cause instanceof Error ? cause.message : String(cause)}. Inspect this thread before retrying; do not create another.`);
  }
  return { threadId };
}

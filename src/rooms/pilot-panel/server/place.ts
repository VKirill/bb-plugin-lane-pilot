import { isNotFound, orMiss, stringAt, valueAt } from "@lane-pilot/kit";
import { detectRequiredSessionPolicyCapability } from "../../contracts";
import type { ServerCore } from "../../contracts/server";
import { listOpenAttempts } from "../../storage";
import type { PilotChildThread, PilotDelegationChoice, PilotDelegationView } from "../index";

export interface ResolvedThreadPlace {
  threadId: string;
  providerId: string | null;
  threadState: string;
  archived: boolean;
  pendingQuestions: number | null;
  pluginRole: string | null;
  projectId: string | null;
  projectName: string | null;
  environmentId: string | null;
  hostId: string | null;
  rootPath: string | null;
}

const isThreadStorageScratchPath = (p: string | null): boolean =>
  Boolean(p && /\.bb-machines\/.*\/thread-storage(?:\/|$)/.test(p));

export async function resolveThreadPlace(ctx: ServerCore, threadId: string): Promise<ResolvedThreadPlace> {
  const { bb } = ctx;
  const thread = await orMiss(bb.sdk.threads.get({ threadId }), null, isNotFound);
  const meta = await orMiss(bb.sdk.threads.getPluginMetadata({ threadId }), null, isNotFound);
  const pluginRole = typeof valueAt(meta, "role") === "string" ? (valueAt(meta, "role") as string) : null;
  const providerId = stringAt(thread, "providerId") ?? null;
  const projectId = stringAt(thread, "projectId") ?? null;
  const environmentId = stringAt(thread, "environmentId") ?? null;
  const archived = valueAt(thread, "archivedAt") != null;
  const runtimeObj = valueAt(thread, "runtime") as { displayStatus?: unknown } | undefined;
  const threadState =
    (typeof runtimeObj?.displayStatus === "string" ? runtimeObj.displayStatus : null) ??
    stringAt(thread, "status") ??
    "idle";

  let pendingQuestions: number | null = null;
  try {
    if (typeof bb.sdk.threads.interactions?.list === "function") {
      const list = await bb.sdk.threads.interactions.list({ threadId });
      pendingQuestions = Array.isArray(list) ? list.length : 0;
    }
  } catch {
    pendingQuestions = null;
  }

  let projectName: string | null = null;
  let hostId: string | null = null;
  let rootPath: string | null = null;

  if (environmentId && typeof bb.sdk.environments?.get === "function") {
    const env = await orMiss(bb.sdk.environments.get({ environmentId }), null, isNotFound);
    const envHost = stringAt(env, "hostId") ?? null;
    const envPath = stringAt(env, "path") ?? null;
    if (!isThreadStorageScratchPath(envPath)) {
      hostId = envHost;
      rootPath = envPath;
    }
  }
  if (projectId && typeof bb.sdk.projects?.get === "function") {
    const proj = (await orMiss(bb.sdk.projects.get({ projectId }), null, isNotFound)) as {
      name?: unknown;
      sources?: Array<{ hostId?: string; path?: string; isDefault?: boolean }>;
    } | null;
    if (typeof proj?.name === "string") projectName = proj.name;
    if ((!hostId || !rootPath) && Array.isArray(proj?.sources) && proj.sources.length > 0) {
      const pick = proj.sources.find((s) => s.isDefault && s.hostId && s.path) ?? proj.sources.find((s) => s.hostId && s.path);
      if (pick?.hostId && pick?.path) {
        hostId = pick.hostId;
        rootPath = pick.path;
      }
    }
  }
  return {
    threadId,
    providerId,
    threadState: archived ? "archived" : pendingQuestions && pendingQuestions > 0 ? "awaiting_input" : threadState,
    archived,
    pendingQuestions,
    pluginRole,
    projectId,
    projectName,
    environmentId,
    hostId,
    rootPath,
  };
}

export async function collectDelegationView(
  ctx: ServerCore,
  place: ResolvedThreadPlace,
  choice: PilotDelegationChoice,
  configured: boolean,
  error: string | null,
  activeRunId: string | null,
): Promise<PilotDelegationView> {
  const { bb, db } = ctx;
  const cleanCap = detectRequiredSessionPolicyCapability(
    (bb as { agents?: { experimental_vkRequiredSessionPolicy?: unknown } }).agents ?? {},
  );
  const [providersRaw, childrenRaw] = await Promise.all([
    place.environmentId && typeof bb.sdk.providers?.list === "function"
      ? bb.sdk.providers.list({ environmentId: place.environmentId }).catch(() => [])
      : place.hostId && typeof bb.sdk.providers?.list === "function"
        ? bb.sdk.providers.list({ hostId: place.hostId } as never).catch(() => [])
        : Promise.resolve([]),
    typeof bb.sdk.threads.list === "function"
      ? bb.sdk.threads.list({ parentThreadId: place.threadId, limit: 20 }).catch(() => [])
      : Promise.resolve([]),
  ]);

  const providers = (Array.isArray(providersRaw) ? providersRaw : [])
    .filter((p) => (p as { available?: unknown }).available !== false && typeof (p as { id?: unknown }).id === "string")
    .map((p) => ({
      id: String((p as { id: unknown }).id),
      name: String((p as { displayName?: unknown; id: unknown }).displayName ?? (p as { id: unknown }).id),
    }));

  const seenIds = new Set<string>();
  const children: PilotChildThread[] = [];
  for (const row of Array.isArray(childrenRaw) ? childrenRaw : []) {
    const cid = stringAt(row, "id");
    if (!cid || seenIds.has(cid)) continue;
    seenIds.add(cid);
    const meta = await orMiss(bb.sdk.threads.getPluginMetadata({ threadId: cid }), null, isNotFound);
    const cRole = typeof valueAt(meta, "role") === "string" ? (valueAt(meta, "role") as string) : null;
    const isPmChild = cRole === "pm" || cRole === "bench-pm";
    children.push({
      id: cid,
      title: stringAt(row, "title") ?? "Субтред без названия",
      status: stringAt(row, "status") ?? "idle",
      role: cRole ?? "subthread",
      providerId: stringAt(row, "providerId") ?? null,
      cleanSession: isPmChild ? false : cRole ? cleanCap : true,
    });
  }

  if (activeRunId) {
    const openForRun = listOpenAttempts(db).filter((att) => att.run_id === activeRunId).slice(0, 12);
    for (const att of openForRun) {
      if (!att.thread_id || seenIds.has(att.thread_id)) continue;
      seenIds.add(att.thread_id);
      children.push({
        id: att.thread_id,
        title: `Дорожка ${att.task_id}`,
        status: att.state === "running" ? "active" : att.state,
        role: "writer",
        providerId: null,
        cleanSession: cleanCap,
      });
    }
  }

  return { choice, configured, error, providers, children };
}

import { getRun, getRunSettingsScopes, loadProjectSettings, loadRunHelperPolicyJson, openDatabase, persistRunHelperPolicyJson } from "../database";
import { decideHelperDispatch, detectVkCapability, parseHelperContextSettings, parseRequiredSessionPolicyCapability, requiredSessionPolicySpawnBinding } from "../helper-context";
import type { HelperPolicySnapshot } from "../helper-context";
import { helperSpawnFields, resolveHelperPlacement } from "../helper-placement";
import { LP_DEFAULTS_KEY, inheritProjectValues, parseHelperPlacement, parseLanePilotDefaults } from "../lp-defaults";
import type { HelperPlacementMode } from "../lp-defaults";
import { stringAt } from "./values";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
export class WriterSelectionError extends Error {}

export const NATIVE_WRITER_KEYS = new Set(["writer.provider", "writer.model", "writer.reasoning_effort", "writer.service_tier"]);

export const NATIVE_MEMORY_KEYS = new Set(["memory.provider", "memory.model", "memory.reasoning_effort", "memory.service_tier"]);

export const NATIVE_NIGHT_REVIEW_KEYS = new Set(["night_review.provider", "night_review.model", "night_review.reasoning_effort", "night_review.service_tier"]);

export const NATIVE_DOCS_KEYS = new Set(["docs.provider", "docs.model", "docs.reasoning_effort", "docs.service_tier"]);

export const NATIVE_PROJECT_LIFE_KEYS = new Set(["project_life.provider", "project_life.model", "project_life.reasoning_effort", "project_life.service_tier"]);

export const NATIVE_ONBOARDING_KEYS = new Set(["onboarding.provider", "onboarding.model", "onboarding.reasoning_effort", "onboarding.service_tier"]);

export const NATIVE_PM_READ_KEYS = new Set(["pm_read.provider", "pm_read.model", "pm_read.reasoning_effort", "pm_read.service_tier"]);

export const NATIVE_PLAN_CRITIQUE_KEYS = new Set(["plan_critique.provider", "plan_critique.model", "plan_critique.reasoning_effort", "plan_critique.service_tier"]);

export const NATIVE_CODE_CRITIQUE_KEYS = new Set(["code_critique.provider", "code_critique.model", "code_critique.reasoning_effort", "code_critique.service_tier"]);

export const NATIVE_SPECIALIST_KEYS = new Set(["specialist.provider", "specialist.model", "specialist.reasoning_effort", "specialist.service_tier"]);

export function parseRunHelperJson(stored: string | null): Record<string, unknown> | null {
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function routingFieldsFromSettings(settings: Record<string, unknown>): { helperPlacement: HelperPlacementMode; qaHostId: string | null } {
  const host = settings["browser_qa.host_id"];
  return {
    helperPlacement: parseHelperPlacement(settings["helper.placement"]),
    qaHostId: typeof host === "string" && host.trim() ? host.trim() : null,
  };
}

export function runRoutingFromParsed(parsed: Record<string, unknown> | null): { helperPlacement: HelperPlacementMode; qaHostId: string | null } | null {
  if (!parsed || typeof parsed.helperPlacement !== "string") return null;
  const host = parsed.qaHostId;
  return {
    helperPlacement: parseHelperPlacement(parsed.helperPlacement),
    qaHostId: typeof host === "string" && host.trim() ? host.trim() : null,
  };
}

export async function inheritedProjectSettings(bb: BbPluginApi, db: ReturnType<typeof openDatabase>, projectId: string, scopes: readonly string[] = []): Promise<Record<string, unknown>> {
  return inheritProjectValues(
    loadProjectSettings(db, projectId, scopes),
    parseLanePilotDefaults(await bb.storage.kv.get(LP_DEFAULTS_KEY)),
  ).values;
}

export function freezeRunRouting(
  db: ReturnType<typeof openDatabase>,
  runId: string,
  settings: Record<string, unknown>,
): { helperPlacement: HelperPlacementMode; qaHostId: string | null } {
  const stored = loadRunHelperPolicyJson(db, runId);
  const parsed = parseRunHelperJson(stored);
  const existing = runRoutingFromParsed(parsed);
  if (existing) return existing;
  const routing = routingFieldsFromSettings(settings);
  const helperParsed = parseHelperContextSettings(settings);
  const helperSettings = helperParsed.ok
    ? helperParsed.settings
    : { mode: "inherit" as const, skills: [] as string[], mcpServers: [] as string[], bbPlugins: [] as string[], nativePlugins: [] as string[] };
  persistRunHelperPolicyJson(db, runId, JSON.stringify({
    schemaVersion: 1,
    mode: helperSettings.mode,
    settings: helperSettings,
    parentRequired: false,
    parentPolicy: null,
    policy: parsed && "policy" in parsed ? parsed.policy : null,
    ...(parsed ?? {}),
    ...routing,
  }));
  return routing;
}

export function criticReconcilePort(bb: BbPluginApi, projectId: string) {
  return {
    list: async ({ limit, offset }:{limit:number;offset:number}) => (await bb.sdk.threads.list({
      projectId,
      originPluginId: "lane-pilot",
      includeHidden: true,
      limit,
      offset,
    })).map((thread) => ({ id: thread.id })),
    metadata: async (threadId: string) => bb.sdk.threads.getPluginMetadata({ threadId }),
  };
}

export const CRITIC_OUTCOME_UNKNOWN = "code_critique_outcome_unknown";

export function resolveHelperDispatch(input:{bb:BbPluginApi;db:ReturnType<typeof openDatabase>;projectId:string;runId:string}): ReturnType<typeof decideHelperDispatch> {
  const stored = loadRunHelperPolicyJson(input.db, input.runId);
  let snapshot: HelperPolicySnapshot | null = null;
  if (stored) {
    try { snapshot = JSON.parse(stored) as HelperPolicySnapshot; }
    catch { return { ok: false, reason: "helper_context_snapshot_invalid" }; }
    if (snapshot?.schemaVersion !== 1 || (snapshot.mode !== "inherit" && snapshot.mode !== "selected" && snapshot.mode !== "none")) {
      return { ok: false, reason: "helper_context_snapshot_invalid" };
    }
  }
  const parsed = parseHelperContextSettings(loadProjectSettings(input.db,input.projectId,getRunSettingsScopes(input.db,input.runId)));
  if (!parsed.ok && !snapshot) return { ok: false, reason: parsed.reason };
  const settings = snapshot?.settings ?? (parsed.ok ? parsed.settings : { mode: "inherit" as const, skills: [], mcpServers: [], bbPlugins: [], nativePlugins: [] });
  const capability = detectVkCapability((input.bb as { agents?: { experimental_vkSessionPolicy?: unknown; experimental_vkRequiredSessionPolicy?: unknown } }).agents ?? {});
  const decision = decideHelperDispatch({ settings, capability, snapshot });
  if (decision.ok && !stored) persistRunHelperPolicyJson(input.db, input.runId, JSON.stringify(decision.snapshot));
  return decision;
}

export function requireHelperSpawn(input:{bb:BbPluginApi;db:ReturnType<typeof openDatabase>;projectId:string;runId:string}): HelperPolicySnapshot {
  const decision = resolveHelperDispatch(input);
  if (!decision.ok) throw new Error(decision.reason);
  return decision.snapshot;
}

export function requiredPolicyField(bb: BbPluginApi, snapshot: HelperPolicySnapshot, providerId?: string) {
  const agents = (bb as { agents?: { experimental_vkSessionPolicy?: unknown; experimental_vkRequiredSessionPolicy?: unknown } }).agents ?? {};
  return requiredSessionPolicySpawnBinding({
    capability: detectVkCapability(agents),
    advertised: parseRequiredSessionPolicyCapability(agents),
    snapshot,
    providerId,
  });
}

export async function helperChildPlacement(input:{
  bb:BbPluginApi;db:ReturnType<typeof openDatabase>;projectId:string;runId:string;role:string;taskTitle?:string;
}): Promise<ReturnType<typeof helperSpawnFields>> {
  const run = getRun(input.db, input.runId);
  const parentId = run?.pm_thread_id;
  if (!parentId) throw new Error("helper_parent_thread_missing");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const parentThread = await Promise.race([
    input.bb.sdk.threads.get({ threadId:parentId }),
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 2_000); }),
  ]).finally(() => { if (timer) clearTimeout(timer); }).catch(() => null);
  if (!parentThread) throw new Error("helper_parent_thread_unresolved");
  const threadProject = stringAt(parentThread, "projectId");
  if (!threadProject) throw new Error("helper_parent_identity_unresolved");
  if (threadProject !== input.projectId) throw new Error("helper_parent_project_mismatch");
  // A root PM chat (the user's own native Lane chat, or a PM Enable spawned without a source thread)
  // is its own source and lifecycle owner. Before this, a root `bb` PM failed every writer spawn with
  // helper_parent_relation_missing (hub log 2026-09-27), surfacing only as a misleading reconcile reason.
  const rootPm = run?.kind === "cli" || !stringAt(parentThread, "parentThreadId");
  // A PM enabled from a chat is that chat's child; BB no longer stores the chat as its source, so the parent is.
  const sourceThreadId = stringAt(parentThread, "sourceThreadId") ?? (rootPm ? parentId : stringAt(parentThread, "parentThreadId"));
  const lifecycleOwnerThreadId = stringAt(parentThread, "lifecycleOwnerThreadId") ?? (rootPm ? parentId : null);
  if (!sourceThreadId || !lifecycleOwnerThreadId) throw new Error("helper_parent_relation_missing");
  const settings = await inheritedProjectSettings(input.bb,input.db,input.projectId,getRunSettingsScopes(input.db,input.runId));
  const routing = freezeRunRouting(input.db, input.runId, settings);
  const resolved = resolveHelperPlacement({
    mode: routing.helperPlacement,
    projectId: threadProject,
    parent: {
      id: parentId,
      projectId: threadProject,
      sectionId: stringAt(parentThread, "sectionId"),
      environmentId: stringAt(parentThread, "environmentId"),
      sourceThreadId,
      lifecycleOwnerThreadId,
    },
    role: input.role,
    taskTitle: input.taskTitle,
  });
  if (!resolved.ok) throw new Error(resolved.reason);
  return helperSpawnFields(resolved.placement);
}

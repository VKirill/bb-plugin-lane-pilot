import {
  ROLE_PROFILES,
  canonicalSkillName,
  effectiveGroup,
  nativeAgentCliId,
  nativeSelectionSchema,
  nativeThreadKey,
  parseHelperContextSettings,
  type HelperRole,
  type VkSessionPolicy,
} from "../../contracts";
import type { ServerCore } from "../../contracts/server";
import { loadProjectSettings } from "../../storage";
import { agentKind, compileEffectiveMainAgent } from "../agent-profile";
import { pendingSwitch } from "../native-session";

/**
 * Curated domain skill packs preloaded into `<available_skills>` ONLY for standalone Composer specialist chats
 * (where there is no workflow node passing step-specific `skills`), preventing all 200-300+ global `~/.bb/skills`
 * from flooding the system prompt on every turn while keeping core domain methodology ready at hand.
 */
export const STANDALONE_SPECIALIST_SKILL_PACKS: Readonly<Record<string, readonly string[]>> = {
  "seo-specialist": [
    "seo-drmax-orchestrator",
    "seo-evidence-contract",
    "seo-tools",
    "topical-graph-architect",
    "seo-page-templates",
    "gist-content-logic",
    "seo-tech-audit-kit",
    "seo-measurement-loop",
    "seo-ai-visibility",
    "seo-trust-eeat",
    "seo-linkbuilding-method",
    "seo-update-forensics",
  ],
  "growth-marketer": [
    "mkt-end-to-end-analytics",
    "mkt-organic-content",
    "mkt-ab-mde-alerts",
    "mkt-landing-cro",
    "mkt-yandex-direct-epk",
    "mkt-telegram-ads-method",
  ],
};

export type SessionPolicyContextLike = {
  thread?: { id?: string } | null;
  project?: { id?: string } | null;
  pluginMetadata?: Record<string, unknown> | null;
};

/**
 * Resolves a bounded `skills` session policy for standalone Composer specialist chats (`native-thread:<threadId>`).
 * Returns `null` for ordinary chats, PM coordinator chats, and workflow/helper child threads (which carry their own
 * exact `experimental_vkRequiredSessionPolicy` snapshot from `threads.spawn`).
 */
export function createNativeSpecialistSessionPolicy(ctx: Pick<ServerCore, "bb" | "db" | "ownedAgents">) {
  return async (context: SessionPolicyContextLike): Promise<VkSessionPolicy | null> => {
    const threadId = typeof context.thread?.id === "string" ? context.thread.id.trim() : "";
    if (!threadId) return null;
    const meta = context.pluginMetadata ?? {};
    const metaRole = typeof meta.role === "string" ? meta.role : "";
    if ((metaRole && metaRole !== "pm") || typeof meta.lanePilotWorkflowRunId === "string") return null;

    const rawBound = await ctx.bb.storage.kv.get(nativeThreadKey(threadId));
    const parsedBound = rawBound ? nativeSelectionSchema.safeParse(rawBound) : null;
    const selected = parsedBound?.success ? parsedBound.data : await pendingSwitch(ctx.bb.storage.kv, threadId);
    if (!selected || selected.parentRunId) return null;

    const shortId = nativeAgentCliId(selected.agentId);
    if (agentKind(shortId) !== "specialist") return null;

    const projectId = (typeof context.project?.id === "string" && context.project.id.trim()) || selected.projectId;
    const settingsParsed = parseHelperContextSettings(loadProjectSettings(ctx.db, projectId));
    if (!settingsParsed.ok || settingsParsed.settings.mode === "inherit") return null;
    if (settingsParsed.settings.mode === "none") return { skills: { mode: "allow", names: [] } };
    if (settingsParsed.settings.mode === "selected") return { skills: { mode: "allow", names: settingsParsed.settings.skills } };

    const helperRole = (`specialist:${shortId}`) as HelperRole;
    const roleAccess = Object.hasOwn(ROLE_PROFILES, helperRole) ? settingsParsed.settings.roleAccess?.[helperRole] : undefined;
    const group = effectiveGroup(helperRole, "skills", roleAccess);
    if (group.names === null) return null;
    if (group.source === "owner") return { skills: { mode: "allow", names: group.names } };

    const ownedRow = (await ctx.ownedAgents())[shortId];
    let profileSkills: string[] = [];
    try {
      profileSkills = compileEffectiveMainAgent(shortId, ownedRow).skills ?? [];
    } catch {
      profileSkills = [];
    }
    const domainPack = STANDALONE_SPECIALIST_SKILL_PACKS[shortId] ?? [];
    const names = [...new Set([
      ...group.names,
      ...profileSkills.map(canonicalSkillName),
      ...domainPack.map(canonicalSkillName),
      "agent-tools",
    ])];
    return { skills: { mode: "allow", names } };
  };
}

/** Registers `createNativeSpecialistSessionPolicy` on `bb.agents.experimental_vkSessionPolicy` when supported. */
export function mountNativeSpecialistSessionPolicy(ctx: Pick<ServerCore, "bb" | "db" | "ownedAgents">): boolean {
  const agents = (ctx.bb as { agents?: { experimental_vkSessionPolicy?: (resolver: (c: SessionPolicyContextLike) => Promise<VkSessionPolicy | null>) => void } }).agents;
  if (typeof agents?.experimental_vkSessionPolicy !== "function") return false;
  agents.experimental_vkSessionPolicy(createNativeSpecialistSessionPolicy(ctx));
  return true;
}

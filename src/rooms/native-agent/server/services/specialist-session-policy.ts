import {
  LEAD_ID,
  ROLE_PROFILES,
  canonicalSkillName,
  effectiveGroup,
  isEmployeeSpecialist,
  nativeAgentCliId,
  nativeSelectionSchema,
  nativeThreadKey,
  parseHelperContextSettings,
  type ExtraAccess,
  type HelperRole,
  type VkSessionPolicy,
} from "../../../contracts";
import { WORKFLOW_ARCHITECT_ID, isStockProfileId, type ServerCore } from "../../../contracts/server";
import { loadProjectSettings } from "../../../storage";
import {
  PROFILE_SOURCE_VERSION,
  agentKind,
  compileEffectiveMainAgent,
  compileMainAgentProfile,
  type StoredAgentRow,
} from "../../models/agent-profile";
import { pendingSwitch } from "../../models/native-session";

/**
 * Curated, self-sufficient domain skill packs preloaded ONLY in open-ended specialist sessions
 * (standalone Composer chats, PM `specialist` delegations, and scheduled `agent-routine` runs where no workflow step
 * passes node-specific `skills`), preventing 200-300+ global `~/.bb/skills` from leaking into `<available_skills>`.
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
    "seo-programmatic-bofu",
    "seo-release-protocol",
    "seo-project-life",
    "google",
    "yandex",
  ],
  "growth-marketer": [
    "mkt-end-to-end-analytics",
    "mkt-organic-content",
    "mkt-ab-mde-alerts",
    "mkt-landing-cro",
    "mkt-yandex-direct-epk",
    "mkt-telegram-ads-method",
    "telegram-ads",
    "google",
    "yandex",
  ],
  "copy-lead": [
    "copywriter",
    "copy-project-life",
    "copy-research",
    "site-copy-audience",
    "site-copy-headlines",
    "site-copy-ux",
    "site-craft-standard",
    "ru-text",
    "ru-check",
    "ru-score",
    "ai-detect",
  ],
  "design-lead": [
    "project-design",
    "modern-web-guidance",
    "page-prototype",
    "web-design",
    "landing-page-design",
    "ui-ux-pro-max",
    "design-taste",
    "impeccable-ui",
    "ui-review",
    "unslop",
    "app-designer",
  ],
  "video-lead": [
    "video-lead-playbook",
    "business-motion-film",
    "procedural-film",
    "video-to-reels",
    "claude-video",
    "hyperframes",
    "hyperframes-cli",
    "media-use",
    "video-sound",
    "video-transcribe",
    "manimgx",
  ],
  "3d-artist": [
    "blender-director",
    "blender-modeler",
    "blender-shared-references",
    "hard-surface",
    "procedural-modeling",
    "prop-artist",
    "character-artist",
    "materials",
    "lighting",
    "rendering",
    "uv-workflow",
    "asset-optimization",
    "export-pipeline",
    "qa-review",
  ],
  "game-dev": [
    "roblox-toolkit",
    "roblox-build",
    "roblox-design",
    "game-teardown",
    "threejs-fundamentals",
    "threejs-interaction",
    "threejs-lighting",
    "threejs-loaders",
    "godot-export",
    "unity-export",
  ],
  "social-manager": [
    "telegram-user",
    "telegram-rich-messages",
    "social-browser",
    "social-insights",
    "text-insights",
    "tg-search",
    "ig-post-assistant",
    "ru-text",
  ],
  "billing-assistant": ["kontur-elba", "edo-diadoc", "cloudpayments"],
  "visual-artist": ["image-prompting", "nano-banana", "xmlstock-image-research"],
  "macos-operator": ["computer-use", "browser-automation", "linux-sysadmin"],
  tavily: ["tavily", "copy-research", "xmlstock-image-research", "alphaxiv"],
  "advisor-researcher": ["tavily", "copy-research", "alphaxiv"],
  "ai-researcher": ["tavily", "copy-research", "alphaxiv"],
  "domain-researcher": ["tavily", "copy-research", "alphaxiv"],
  "ui-researcher": ["impeccable-ui", "ui-ux-pro-max", "ui-review", "project-design"],
  "project-onboarder": ["project-life", "project-onboard"],
  [WORKFLOW_ARCHITECT_ID]: ["lane-pilot"],
  "nyquist-auditor": ["lane-pilot"],
};

const RESEARCH_SUBROLES: ReadonlySet<string> = new Set([
  "advisor-researcher",
  "ai-researcher",
  "domain-researcher",
]);

const CATALOG_ENABLED_STOCK_IDS: ReadonlySet<string> = new Set([
  WORKFLOW_ARCHITECT_ID,
  "advisor-researcher",
  "ai-researcher",
  "domain-researcher",
  "ui-researcher",
]);

function usesSkillCatalog(shortId: string, ownedRow?: StoredAgentRow): boolean {
  if (isEmployeeSpecialist(shortId) || CATALOG_ENABLED_STOCK_IDS.has(shortId)) return true;
  if (!isStockProfileId(shortId) && Boolean(ownedRow?.meta?.skillSections?.length)) return true;
  return false;
}

function sameStringList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, idx) => v === b[idx]);
}

function helperRoleForProfile(shortId: string): HelperRole | null {
  if (shortId === WORKFLOW_ARCHITECT_ID) return "workflow-architect";
  if (shortId === LEAD_ID) return "lead";
  if (shortId === "project-onboarder") return "onboarder";
  if (shortId === "browser-qa") return "browser-qa";
  const specRole = (`specialist:${shortId}`) as HelperRole;
  if (Object.hasOwn(ROLE_PROFILES, specRole)) return specRole;
  if (!isStockProfileId(shortId) || RESEARCH_SUBROLES.has(shortId)) return specRole;
  return null;
}

/**
 * Resolves a specialist profile's `ExtraAccess` for workflow steps (`openEnded: false`) or open-ended sessions
 * (`openEnded: true` for Composer chats, `specialist` delegations, and `agent-routine` schedules).
 * Prevents legacy `bundled-agents.json` disabled MCP servers from leaking into stock employee steps unless edited by the owner.
 */
export function specialistProfileAccess(
  shortId: string,
  ownedRow?: StoredAgentRow,
  options?: { openEnded?: boolean },
): ExtraAccess {
  let compiled: ReturnType<typeof compileEffectiveMainAgent> | null = null;
  try {
    compiled = compileEffectiveMainAgent(shortId, ownedRow);
  } catch {
    compiled = null;
  }
  const openEnded = Boolean(options?.openEnded);
  const profileSkills = [
    ...(compiled?.skills ?? []),
    ...(ownedRow?.meta?.coreSkills ?? []),
  ].map(canonicalSkillName);
  const domainPack = openEnded ? (STANDALONE_SPECIALIST_SKILL_PACKS[shortId] ?? []).map(canonicalSkillName) : [];
  const needsCatalog = openEnded && usesSkillCatalog(shortId, ownedRow);
  const skills = [...new Set([
    ...profileSkills,
    ...domainPack,
    ...(needsCatalog ? ["agent-tools"] : []),
  ])];

  let mcpServers: string[] | undefined;
  if (compiled?.mcpServers?.length) {
    if (!isEmployeeSpecialist(shortId)) {
      mcpServers = [...compiled.mcpServers];
    } else if (ownedRow?.compiled?.sourceVersion === PROFILE_SOURCE_VERSION) {
      const stockMcp = compileMainAgentProfile(shortId).mcpServers ?? [];
      if (!sameStringList(compiled.mcpServers, stockMcp)) mcpServers = [...compiled.mcpServers];
    }
  }

  return {
    ...(needsCatalog ? { bbPlugins: ["agent-tools"] } : {}),
    ...(skills.length ? { skills } : {}),
    ...(mcpServers?.length ? { mcpServers } : {}),
  };
}

export type SessionPolicyContextLike = {
  thread?: { id?: string } | null;
  project?: { id?: string } | null;
  pluginMetadata?: Record<string, unknown> | null;
};

/**
 * Resolves a bounded `skills` session policy for standalone Composer specialist/internal chats (`native-thread:<threadId>`).
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
    if (agentKind(shortId) === "coordinator") return null;

    const projectId = (typeof context.project?.id === "string" && context.project.id.trim()) || selected.projectId;
    const settingsParsed = parseHelperContextSettings(loadProjectSettings(ctx.db, projectId));
    if (!settingsParsed.ok || settingsParsed.settings.mode === "inherit") return null;
    if (settingsParsed.settings.mode === "none") return { skills: { mode: "allow", names: [] } };
    if (settingsParsed.settings.mode === "selected") return { skills: { mode: "allow", names: settingsParsed.settings.skills } };

    const helperRole = helperRoleForProfile(shortId);
    let baseSkills: string[] = [];
    if (helperRole) {
      const roleAccess = Object.hasOwn(ROLE_PROFILES, helperRole) ? settingsParsed.settings.roleAccess?.[helperRole] : undefined;
      const group = effectiveGroup(helperRole, "skills", roleAccess);
      if (group.names === null) return null;
      if (group.source === "owner") return { skills: { mode: "allow", names: group.names } };
      baseSkills = group.names;
    }

    const ownedRow = (await ctx.ownedAgents())[shortId];
    const extra = specialistProfileAccess(shortId, ownedRow, { openEnded: true });
    const names = [...new Set([...baseSkills, ...(extra.skills ?? [])])];
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

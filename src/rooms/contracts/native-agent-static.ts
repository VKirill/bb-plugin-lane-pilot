import { LEAD_ID, LEAD_SUMMARY } from "./lead-agent";

/** The Workflow architect's id and one-line summary. The workflow room owns the profile (src/rooms/native-agent/workflow-architect.ts);
 * the agent summary catalog is shared and must not import a domain room, so the two values are repeated here. Keep them in step. */
export const WORKFLOW_ARCHITECT_ID = "workflow-architect";
export const WORKFLOW_ARCHITECT_SUMMARY = "Workflow architect: interviews the owner about a repeatable process and builds it as a tested chain (agent, action, human and code steps) live; does not edit product code or dispatch writers.";

/** The only check this package ships. Later packages add the real ones. */
export const RESULT_EXISTS = "result-exists";

export function resultExists(files: readonly string[]): { ok: true } | { ok: false; reason: string } {
  return files.length ? { ok: true } : { ok: false, reason: "no result files" };
}

export type EmployeeManifest = {
  domain: string;
  machineAffinity: string;
  deliverables: string[];
  validator: string;
  /** 0–3 skills that are always loaded. The rest come from `skillSections`. */
  coreSkills: string[];
  /** Catalog sections, «Раздел/Подраздел», searched before the neighbours. */
  skillSections: string[];
};

/**
 * Built-in employees. A long skill list is not a lock: `coreSkills` is what the profile always has,
 * `skillSections` is where the agent looks first in `bb tools skills-tree`.
 * There is no Roblox section in the tree; Roblox skills sit under «Разработка/Игры».
 */
export const EMPLOYEES: Record<string, EmployeeManifest> = {
  "3d-artist": {
    domain: "3d",
    machineAffinity: "mac-mini",
    deliverables: [".agents/3d/"],
    validator: RESULT_EXISTS,
    coreSkills: ["blender-director"],
    skillSections: [
      "3D и Blender/Моделирование",
      "3D и Blender/Материалы, свет, рендер",
      "3D и Blender/Персонажи и анимация",
      "3D и Blender/Стили и арт-дирекция",
      "3D и Blender/Пайплайн и экспорт",
    ],
  },
  "game-dev": {
    domain: "games",
    machineAffinity: "mac-mini",
    deliverables: [".agents/games/"],
    validator: RESULT_EXISTS,
    coreSkills: [],
    skillSections: [
      "Разработка/Игры",
      "Разработка/3D в браузере",
      "3D и Blender/Жанры игр",
      "3D и Blender/Пайплайн и экспорт",
    ],
  },
  "social-manager": {
    domain: "social",
    machineAffinity: "any",
    deliverables: [".agents/social/"],
    validator: RESULT_EXISTS,
    coreSkills: ["telegram-user"],
    skillSections: ["Маркетинг/Соцсети и инсайты", "Маркетинг/Telegram Ads"],
  },
  "billing-assistant": {
    domain: "billing",
    machineAffinity: "mac-mini",
    deliverables: [".agents/billing/"],
    validator: RESULT_EXISTS,
    coreSkills: ["kontur-elba"],
    skillSections: ["Бизнес и документы/Бухгалтерия и ЭДО"],
  },
  "visual-artist": {
    domain: "visual",
    machineAffinity: "any",
    deliverables: [".agents/visual/"],
    validator: RESULT_EXISTS,
    coreSkills: ["image-prompting"],
    skillSections: ["Дизайн/Генерация изображений", "Дизайн/Стили изображений"],
  },
  "macos-operator": {
    domain: "macos",
    machineAffinity: "mac-mini",
    deliverables: [".agents/macos/"],
    validator: RESULT_EXISTS,
    coreSkills: ["computer-use"],
    skillSections: ["Инфраструктура и серверы/Инфраструктура и серверы"],
  },
  "video-lead": {
    domain: "video",
    machineAffinity: "any",
    deliverables: [".agents/video/"],
    validator: RESULT_EXISTS,
    coreSkills: ["video-lead-playbook"],
    skillSections: ["Видео/Монтаж кодом", "Видео/Процедурные фильмы", "Видео/Короткие ролики"],
  },
  "seo-specialist": {
    domain: "seo",
    machineAffinity: "any",
    deliverables: [".agents/seo/"],
    validator: RESULT_EXISTS,
    coreSkills: ["seo-drmax-orchestrator"],
    skillSections: ["Маркетинг/SEO"],
  },
  "growth-marketer": {
    domain: "marketing",
    machineAffinity: "any",
    deliverables: [".agents/marketing/"],
    validator: RESULT_EXISTS,
    coreSkills: ["mkt-end-to-end-analytics"],
    skillSections: [
      "Маркетинг/Яндекс Директ",
      "Маркетинг/Telegram Ads",
      "Маркетинг/Аналитика",
      "Маркетинг/Соцсети и инсайты",
      "Тексты/Копирайт",
    ],
  },
  "design-lead": {
    domain: "design",
    machineAffinity: "any",
    deliverables: [".agents/design/"],
    validator: RESULT_EXISTS,
    coreSkills: ["project-design", "modern-web-guidance"],
    skillSections: ["Дизайн/UI/UX и дизайн-системы"],
  },
  "copy-lead": {
    domain: "copy",
    machineAffinity: "any",
    deliverables: [".agents/copy/"],
    validator: RESULT_EXISTS,
    coreSkills: ["copywriter"],
    skillSections: ["Тексты/Копирайт", "Тексты/Русский текст и редактура"],
  },
  tavily: {
    domain: "research",
    machineAffinity: "any",
    deliverables: [".agents/research/"],
    validator: RESULT_EXISTS,
    coreSkills: ["tavily"],
    skillSections: ["Исследования/Поиск в вебе", "Исследования/Научные статьи", "Исследования/Прочие исследования"],
  },
};

/** The KV key of the role's lesson lines, shared by every reader (specialist brief, employee chat, PM tools). */
export const roleLinesKey = (projectId: string, role: string) => `lp.role.lines:${projectId}:${role}`;

export const MAIN_AGENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MAIN_AGENT_PROFILE_IDS = [
  "dev-orchestrator",
  "copy-lead",
  "seo-specialist",
  "growth-marketer",
  "design-lead",
  "project-onboarder",
  "tavily",
  "video-lead",
  "3d-artist",
  "game-dev",
  "social-manager",
  "billing-assistant",
  "visual-artist",
  "macos-operator",
  WORKFLOW_ARCHITECT_ID,
  LEAD_ID,
  // (2026-10-29 lane-stack port) standalone roles. browser-qa stays reserved for the lp.browser-qa graph.
  "advisor-researcher",
  "ai-researcher",
  "animator",
  "doc-classifier",
  "domain-researcher",
  "eval-auditor",
  "eval-planner",
  "framework-selector",
  "mempalace-curator",
  "nyquist-auditor",
  "ui-researcher",
] as const;

export function isStockProfileId(id: string): boolean {
  return (MAIN_AGENT_PROFILE_IDS as readonly string[]).includes(id);
}

const PM_AGENT_IDS = new Set(["dev-orchestrator", "frontend-orchestrator", "marketing-orchestrator"]);

export function nativeAgentName(agentId: string): string {
  return agentId.split(":").pop() ?? agentId;
}

export function isLanePmAgent(agentId: string): boolean {
  return PM_AGENT_IDS.has(nativeAgentName(agentId));
}

const RESERVED_IDS = new Set(["browser-qa", "default", "general-purpose", "explore", "plan"]);

/** A custom agent may not take the id of a bundled agent, of a Lane PM or of a name the Claude Code CLI reserves. */
export function isReservedAgentId(id: string): boolean {
  return isStockProfileId(id) || isLanePmAgent(id) || RESERVED_IDS.has(id);
}

export function isCustomAgentId(id: string): boolean {
  return !isReservedAgentId(id);
}

/** One line per agent for recipients picked by description (handoff registry): what it does and what it leaves to others. */
export const BB_AGENT_SUMMARIES: Readonly<Record<string, string>> = {
  "dev-orchestrator": "Lane Pilot PM: plans and splits product work, dispatches writers, ships (push, deploy, live check); does not edit product source itself.",
  "copy-lead": "Copywriter: headlines (H1), page and landing copy, microcopy, offers, audience and tone; no code, no SEO keywords.",
  "seo-specialist": "SEO: keywords and semantics, titles and meta, sitemaps, locales, search content plans; no product code, no page copy.",
  "growth-marketer": "Growth marketer: unit economics, Yandex Direct, Telegram Ads, A/B experiments, landing CRO and organic content; no product code.",
  "design-lead": "Designer: user flows, UX/UI audits, gray clickable prototypes, branded mockups, DESIGN.md; no product implementation.",
  "project-onboarder": "Orientation: explains what the repository is and where to start; no documentation generation.",
  tavily: "Web research with cited sources (claim + URL + snippet notes); no copy or code.",
  "video-lead": "Video producer: explainers, reels, launch and procedural films, graphs and diagrams, sound, captions, reviews of finished videos; plans recurring video jobs; no product code.",
  "3d-artist": "3D assets in Blender on the Mac mini; the asset's skill comes from the catalog.",
  "game-dev": "Builds the game the task names (engine and genre from the catalog) on the Mac mini; not Roblox-only.",
  "social-manager": "Posts, replies and audience reads; telegram-user plus the social sections of the catalog.",
  "billing-assistant": "Invoices and closing documents (Elba on the Mac mini, Diadoc on Windows).",
  "visual-artist": "Pictures for the task via the image catalog and the Image Studio plugin.",
  "macos-operator": "The owner's macOS routine on the Mac mini: computer-use (agent-desktop for apps) and the browser plugin.",
  [WORKFLOW_ARCHITECT_ID]: WORKFLOW_ARCHITECT_SUMMARY,
  [LEAD_ID]: LEAD_SUMMARY,
  "advisor-researcher": "One gray area: two or three options, a source for each, and a recommendation; no product code.",
  "ai-researcher": "Current docs, limits and prices of one named AI model or API, with links; does not pick the framework.",
  "animator": "Motion spec for a UI row: trigger, duration, easing, reduced-motion fallback; no static layout and no product code.",
  "doc-classifier": "Sorts project documents by kind and staleness into one table; changes no files.",
  "domain-researcher": "Users, jobs, vocabulary, rules and competitors of the product domain, each claim with a source; no product code.",
  "eval-auditor": "Audits an AI evaluation for a gold set written before tuning, metric honesty and leakage; does not write tests.",
  "eval-planner": "Plans an AI evaluation before the prompt is tuned: gold set, metric, threshold; does not audit an existing eval.",
  "framework-selector": "Picks the kind of model call, then a framework and model with cost, latency and failure modes; does not build the feature.",
  "mempalace-curator": "Proposes memory merges, demotions and re-checks; applies nothing.",
  "nyquist-auditor": "Lists checks a phase is missing, each with the command that should fail without the work; does not write the tests.",
  "ui-researcher": "UI contract: screens, states, breakpoints and checkable points; does not draw the screens.",
};

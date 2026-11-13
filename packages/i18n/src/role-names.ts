/**
 * THE ONE MAP of display names of everything Lane Pilot runs: every agent (an LLM session), every single-call judge, every Codex config profile.
 * The id of an entry is the INTERNAL id (a settings key like `role_model.<id>`, a stored thread role, a graph step's role): it is never renamed.
 * The name is what the owner reads. Rules (tests/agents-doc.test.ts holds them): every id the code knows resolves to a name here (directly or through
 * ROLE_ID_ALIASES), and no two entries share a name, in either language. The settings screens, the helper-thread list, the agent picker and
 * `bb lane-pilot` read this map; the dictionaries of i18n take their role names from it. The full table «who is who» is docs/agents.md.
 *
 * `kind` says what the thing is, so a config profile is never taken for an agent:
 *  - `agent`: an LLM session (a thread in BB) that reads, thinks and may change files or the hub;
 *  - `judge`: one model call with no session and no tools (it answers one message);
 *  - `profile`: a Codex config profile (which tools a Codex session of that kind carries): NOT an agent, it has no job of its own;
 *  - `code`: deterministic code with a name of its own (no model).
 */
export type RoleKind = "agent" | "judge" | "profile" | "code";
export type RoleGroup = "management" | "coders" | "checkers" | "memory" | "council" | "specialists" | "service";
export type RoleNameEntry = { ru: string; en: string; kind: RoleKind; group: RoleGroup };

const agent = (group: RoleGroup, ru: string, en: string): RoleNameEntry => ({ ru, en, kind: "agent", group });
const judge = (group: RoleGroup, ru: string, en: string): RoleNameEntry => ({ ru, en, kind: "judge", group });
const profile = (ru: string, en: string): RoleNameEntry => ({ ru, en, kind: "profile", group: "service" });

export const ROLE_NAMES = {
  // Управление
  "dev-orchestrator": agent("management", "Координатор разработки", "Development coordinator"),
  "lead": agent("management", "Штурман", "Shturman (the lead)"),
  "specialist:lead": agent("management", "Обход Штурмана", "Shturman's round"),
  "analyst": agent("management", "Аналитик", "Analyst"),
  "planner": agent("management", "Планировщик", "Planner"),
  "workflow-architect": agent("management", "Архитектор графов", "Workflow architect"),
  "pm-reader": agent("management", "Разведчик задачи", "Task scout"),
  "onboarder": agent("management", "Знакомство с проектом", "Project onboarding"),
  // Исполнители кода
  "writer": agent("coders", "Исполнитель кода", "Code writer"),
  "emergency-writer": agent("coders", "Аварийный исполнитель кода", "Emergency code writer"),
  "writer.fallback1": agent("coders", "Запасной исполнитель кода №1", "Fallback code writer 1"),
  "writer.fallback2": agent("coders", "Запасной исполнитель кода №2", "Fallback code writer 2"),
  "writer.fallback3": agent("coders", "Запасной исполнитель кода №3", "Fallback code writer 3"),
  "code-repair": agent("coders", "Доработчик по ревью", "Review fixer"),
  "night-fixer": agent("coders", "Ночной исправитель", "Night fixer"),
  "repairer": agent("coders", "Инженер самолечения", "Self-repair engineer"),
  // Проверяющие
  "plan-critic": agent("checkers", "Критик плана", "Plan critic"),
  "plan-critic-light": agent("checkers", "Быстрый критик плана", "Quick plan critic"),
  "code-critic": agent("checkers", "Критик кода", "Code critic"),
  "specialist-reviewer": agent("checkers", "Рецензент-специалист", "Specialist reviewer"),
  "critic-tiebreak": agent("checkers", "Третий голос критиков", "Critic tiebreak"),
  "triager": agent("checkers", "Сортировщик сбоев", "Failure triager"),
  "auditor": agent("checkers", "Аудитор цели", "Goal auditor"),
  "debugger": agent("checkers", "Отладчик", "Debugger"),
  "browser-qa": agent("checkers", "Проверяющий в браузере", "Browser checker"),
  // Память и обучение
  "memory": agent("memory", "Хранитель памяти", "Memory keeper"),
  "memory-judge": judge("memory", "Судья памяти", "Memory judge"),
  "mempalace-curator": agent("memory", "Куратор памяти", "Memory curator"),
  "project-life": agent("memory", "Летописец проекта", "Project chronicler"),
  "docs-maintainer": agent("memory", "Автор документов", "Docs writer"),
  "rules-analyzer": agent("memory", "Анализатор правил", "Rules analyzer"),
  "episode-analyst": agent("memory", "Аналитик эпизодов", "Episode analyst"),
  "harness-editor": agent("memory", "Редактор обвязки", "Harness editor"),
  "harness-composer": agent("memory", "Сборщик обвязки", "Harness composer"),
  "harness-reflection": agent("memory", "Аналитик обвязки", "Harness analyst"),
  "wall-hunter": agent("memory", "Охотник ночной стены", "Night wall hunter"),
  "wall-analyst": agent("memory", "Аналитик стены", "Wall analyst"),
  "jev": judge("memory", "Быстрый судья Jev", "Jev, the quick judge"),
  // Совет
  "council-seat": agent("council", "Участник совета", "Council member"),
  "council.product": agent("council", "Директор по продукту", "Product director"),
  "council.demand": agent("council", "Директор по спросу", "Demand director"),
  "council.audience": agent("council", "Директор по аудитории", "Audience director"),
  "council.skeptic": agent("council", "Скептик", "Skeptic"),
  "council.growth": agent("council", "Директор по росту", "Growth director"),
  "council.ux": agent("council", "UX-директор", "UX director"),
  "council.chair": agent("council", "Председатель совета", "Council chair"),
  // Специалисты
  "design-lead": agent("specialists", "Дизайнер", "Designer"),
  "copy-lead": agent("specialists", "Копирайтер", "Copywriter"),
  "seo-specialist": agent("specialists", "SEO-специалист", "SEO specialist"),
  "growth-marketer": agent("specialists", "Маркетолог роста", "Growth marketer"),
  "tavily": agent("specialists", "Веб-исследователь", "Web researcher"),
  "video-lead": agent("specialists", "Видеопродюсер", "Video producer"),
  "3d-artist": agent("specialists", "3D-художник", "3D artist"),
  "game-dev": agent("specialists", "Разработчик игр", "Game developer"),
  "social-manager": agent("specialists", "SMM-менеджер", "Social manager"),
  "billing-assistant": agent("specialists", "Ассистент по счетам", "Billing assistant"),
  "visual-artist": agent("specialists", "Визуальный художник", "Visual artist"),
  "macos-operator": agent("specialists", "Оператор macOS", "macOS operator"),
  "specialist": agent("specialists", "Пользовательский специалист", "Custom specialist"),
  "advisor-researcher": agent("specialists", "Советник", "Advisor"),
  "ai-researcher": agent("specialists", "Исследователь моделей", "AI researcher"),
  "animator": agent("specialists", "Аниматор", "Animator"),
  "doc-classifier": agent("specialists", "Классификатор документов", "Doc classifier"),
  "domain-researcher": agent("specialists", "Исследователь области", "Domain researcher"),
  "eval-auditor": agent("specialists", "Аудитор оценки", "Eval auditor"),
  "eval-planner": agent("specialists", "Планировщик оценки", "Eval planner"),
  "framework-selector": agent("specialists", "Подборщик моделей", "Model selector"),
  "nyquist-auditor": agent("specialists", "Аудитор проверок", "Check auditor"),
  "ui-researcher": agent("specialists", "Исследователь интерфейса", "UI researcher"),
  // Служебные
  "errand": agent("service", "Порученец", "Errand runner"),
  "errand-computer": agent("service", "Порученец: экран и приложения", "Errand runner: screen and apps"),
  "errand-devops": agent("service", "Порученец: серверы и машины", "Errand runner: servers and machines"),
  "errand-research": agent("service", "Порученец: разбор и отчёт", "Errand runner: research and report"),
  "errand-browser": agent("service", "Порученец: браузер", "Errand runner: browser"),
  "api-recon": agent("service", "Разведчик API", "API scout"),
  "workspace-provisioner": agent("service", "Держатель рабочей копии", "Worktree holder"),
  "codex-profile:code": profile("Профиль Codex «код»", "Codex profile “code”"),
  "codex-profile:quiet": profile("Профиль Codex «тихий»", "Codex profile “quiet”"),
  "codex-profile:open": profile("Профиль Codex «открытый»", "Codex profile “open”"),
} as const satisfies Record<string, RoleNameEntry>;

export type RoleNameId = keyof typeof ROLE_NAMES;
export const ROLE_NAME_IDS = Object.keys(ROLE_NAMES) as RoleNameId[];

/**
 * Ids the code uses for the same job as an entry above (a thread role, a graph step's role, a stage's old name). They are not entries: one job,
 * one name. A `specialist:<employee>` id is its employee's row of the role table.
 */
export const ROLE_ID_ALIASES: Readonly<Record<string, RoleNameId>> = {
  "gate-triage": "triager",
  "memory-maintainer": "memory",
  "project-life-maintainer": "project-life",
  "project-onboarder": "onboarder",
  "night-reviewer": "auditor",
  "council": "council.chair",
  "worker": "analyst",
  "specialist:design-lead": "design-lead",
  "specialist:copy-lead": "copy-lead",
  "specialist:seo-specialist": "seo-specialist",
  "specialist:growth-marketer": "growth-marketer",
  "specialist:tavily": "tavily",
  "specialist:video-lead": "video-lead",
  "specialist:3d-artist": "3d-artist",
  "specialist:game-dev": "game-dev",
  "specialist:social-manager": "social-manager",
  "specialist:billing-assistant": "billing-assistant",
  "specialist:visual-artist": "visual-artist",
  "specialist:macos-operator": "macos-operator",
};

/** The entry id a role id stands for: itself, or what its alias points at; null when the map does not know it. */
export function canonicalRoleId(id: string): RoleNameId | null {
  if (Object.prototype.hasOwnProperty.call(ROLE_NAMES, id)) return id as RoleNameId;
  return ROLE_ID_ALIASES[id] ?? null;
}

/** The display name of a role id in a language; the id itself when the map does not know it (a custom agent keeps its own name elsewhere). */
export function roleDisplayName(id: string, lang: "ru" | "en" = "ru"): string {
  const key = canonicalRoleId(id);
  return key ? ROLE_NAMES[key][lang] : id;
}

/** «Name (id)»: for command output, where the internal id still has to be there to copy into a setting. */
export function roleLabel(id: string, lang: "ru" | "en" = "ru"): string {
  const key = canonicalRoleId(id);
  return key ? `${ROLE_NAMES[key][lang]} (${id})` : id;
}

/** For the dictionaries of i18n: the name of a role in one language. */
export const roleNameEn = (id: string): string => roleDisplayName(id, "en");
export const roleNameRu = (id: string): string => roleDisplayName(id, "ru");

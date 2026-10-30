import { z } from "zod";

/** The only check this package ships. Later packages add the real ones. */
export const RESULT_EXISTS = "result-exists";

export function resultExists(files: readonly string[]): { ok: true } | { ok: false; reason: string } {
  return files.length ? { ok: true } : { ok: false, reason: "no result files" };
}

export const machineAffinitySchema = z.enum(["mac-mini", "ovh", "windows", "any"]);
export type MachineAffinity = z.infer<typeof machineAffinitySchema>;

export type EmployeeManifest = {
  domain: string;
  machineAffinity: MachineAffinity;
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
  "design-lead": {
    domain: "design",
    machineAffinity: "any",
    deliverables: [".agents/design/"],
    validator: RESULT_EXISTS,
    coreSkills: ["project-design"],
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

export const EMPLOYEE_IDS: readonly string[] = Object.keys(EMPLOYEES);

export function isEmployeeSpecialist(id: string): boolean {
  return Object.hasOwn(EMPLOYEES, id);
}

/**
 * critics branch owns SPECIALIST_ROLES. New employee ids join that list at plugin start
 * until the const itself lists them. Ceiling: a reload before tools.ts runs does not see the push;
 * isEmployeeSpecialist covers that path.
 */
export function installEmployeeSpecialists(roles: string[]): void {
  for (const id of EMPLOYEE_IDS) if (!roles.includes(id)) roles.push(id);
}

/** The old `skills` field is the always-on list. A new `coreSkills` wins and is capped at 3. */
export function coreSkillsOf(input: { skills?: readonly string[] | undefined; coreSkills?: readonly string[] | undefined }): string[] {
  if (input.coreSkills) return input.coreSkills.slice(0, 3);
  return [...(input.skills ?? [])];
}

type EmployeeMeta = {
  domain?: string | undefined;
  machineAffinity?: MachineAffinity | undefined;
  deliverables?: string[] | undefined;
  validator?: string | undefined;
  coreSkills?: string[] | undefined;
  skillSections?: string[] | undefined;
};

/** Own key only: `EMPLOYEES["constructor"]` is the prototype function, not an employee. */
export function stockEmployee(id: string): EmployeeManifest | undefined {
  return Object.hasOwn(EMPLOYEES, id) ? EMPLOYEES[id as keyof typeof EMPLOYEES] : undefined;
}

/** Stock manifest, then the owner's meta, then the compiled profile's skills (an old row that only has `skills`). */
export function employeeView(id: string, meta?: EmployeeMeta, compiledSkills?: string[]): EmployeeManifest {
  const stock = stockEmployee(id);
  return {
    domain: meta?.domain ?? stock?.domain ?? "general",
    machineAffinity: meta?.machineAffinity ?? stock?.machineAffinity ?? "any",
    deliverables: meta?.deliverables ?? stock?.deliverables ?? [],
    validator: meta?.validator ?? stock?.validator ?? RESULT_EXISTS,
    coreSkills: meta?.coreSkills ?? stock?.coreSkills ?? compiledSkills ?? [],
    skillSections: meta?.skillSections ?? stock?.skillSections ?? [],
  };
}

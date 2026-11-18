export type PilotReadinessState = "done" | "todo" | "skipped";

export interface PilotReadinessStep {
  id: "install" | "context" | "architecture" | "quality" | "ci";
  label: string;
  actionId: string;
  state: PilotReadinessState;
  skippable: boolean;
  anyOf: boolean;
  missing: string[];
}

export interface PilotReadinessFacts {
  configured: boolean;
  skillsSynced: boolean;
  missingOrOutdatedSkills: string[];
  hasDescription: boolean;
  hasRulesBase: boolean;
  hasAgentsMd: boolean;
  hasArchitecture: boolean;
  files: Record<string, boolean>;
}

export const PILOT_QUALITY_FILES = [".husky/", "lefthook.yml", ".lefthook.yml", ".pre-commit-config.yaml"] as const;
export const PILOT_CI_FILES = [".github/workflows/", ".gitlab-ci.yml", ".circleci/config.yml", "Jenkinsfile", "bitbucket-pipelines.yml"] as const;

const norm = (path: string) => path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");

const makeStep = (
  id: PilotReadinessStep["id"],
  label: string,
  actionId: string,
  done: boolean,
  missing: string[],
  skippable = false,
  anyOf = false,
): PilotReadinessStep => ({
  id,
  label,
  actionId,
  state: done ? "done" : "todo",
  skippable,
  anyOf,
  missing: done ? [] : missing,
});

export const pilotReadinessHelp: Record<PilotReadinessStep["id"], string> = {
  install:
    "Устанавливает манифест .agents/pilot/config.json, стартовые шаблоны контекста и 11 стандартизированных системных скиллов прямо внутрь проекта (.bb/skills/), чтобы они не были разбросаны по машинам и работали в чистых субтредах.",
  context:
    "/lp-project-setup анализирует стек, команды проверок и конвенции репозитория и заполняет .agents/pilot/DESCRIPTION.md, .agents/pilot/rules/base.md и карту в AGENTS.md. Эти файлы читают оркестратор и чистые субтреды.",
  architecture:
    "Фиксирует границы модулей и правила размещения кода в .agents/pilot/ARCHITECTURE.md, чтобы исполнители клали код в свои «домики» и не создавали циклических импортов.",
  quality:
    "Локальные Git-хуки (.husky/, lefthook.yml или .pre-commit-config.yaml) запускают проверки типов, линтер и быстрые тесты до коммита.",
  ci:
    "Серверный CI (например, GitHub Actions) проверяет сборку и тесты на чистом окружении после каждого push. Для локального или однопользовательского стенда шаг можно пропустить.",
};

export function applyPilotSkipped(steps: PilotReadinessStep[], skipped: readonly string[]): PilotReadinessStep[] {
  const skipSet = new Set(skipped);
  return steps.map((step) =>
    !step.skippable || step.state === "done"
      ? step
      : { ...step, state: skipSet.has(step.id) ? "skipped" : "todo" },
  );
}

export function pilotReadinessSteps(facts: PilotReadinessFacts, skipped: readonly string[] = []): PilotReadinessStep[] {
  const present = new Set(
    Object.entries(facts.files)
      .filter(([, ok]) => ok)
      .map(([rel]) => norm(rel)),
  );
  const has = (rel: string) => present.has(norm(rel));
  const hasDir = (rel: string) => {
    const dir = norm(rel);
    for (const entry of present) {
      if (entry === dir || entry.startsWith(`${dir}/`)) return true;
    }
    return false;
  };
  const anyPresent = (rels: readonly string[]) =>
    rels.some((rel) => (rel.endsWith("/") ? hasDir(rel) : has(rel)));

  const installMissing: string[] = [];
  if (!facts.configured) installMissing.push(".agents/pilot/config.json");
  if (!facts.skillsSynced) {
    installMissing.push(
      facts.missingOrOutdatedSkills.length > 0
        ? `.bb/skills (${facts.missingOrOutdatedSkills.slice(0, 4).join(", ")}${facts.missingOrOutdatedSkills.length > 4 ? "…" : ""})`
        : ".bb/skills/*",
    );
  }

  const contextMissing: string[] = [];
  if (!facts.hasDescription) contextMissing.push(".agents/pilot/DESCRIPTION.md");
  if (!facts.hasRulesBase) contextMissing.push(".agents/pilot/rules/base.md");
  if (!facts.hasAgentsMd) contextMissing.push("AGENTS.md");

  const steps: PilotReadinessStep[] = [
    makeStep(
      "install",
      "Подготовить проект и скиллы в .bb/skills/",
      "prepare-project",
      facts.configured && facts.skillsSynced,
      installMissing,
    ),
    makeStep(
      "context",
      "Описать проект и правила (/lp-project-setup)",
      "setup-context",
      contextMissing.length === 0,
      contextMissing,
    ),
    makeStep(
      "architecture",
      "Описать архитектуру модулей",
      "setup-architecture",
      facts.hasArchitecture,
      [".agents/pilot/ARCHITECTURE.md"],
    ),
    makeStep(
      "quality",
      "Настроить локальные проверки (Git-хуки)",
      "quality-setup",
      anyPresent(PILOT_QUALITY_FILES),
      [...PILOT_QUALITY_FILES],
      true,
      true,
    ),
    makeStep(
      "ci",
      "Настроить CI",
      "ci-setup",
      anyPresent(PILOT_CI_FILES),
      [...PILOT_CI_FILES],
      true,
      true,
    ),
  ];

  return applyPilotSkipped(steps, skipped);
}

export function pilotReadinessComplete(steps: readonly PilotReadinessStep[]): boolean {
  return steps.every((step) => step.state !== "todo");
}

export function nextPilotReadinessStep(steps: readonly PilotReadinessStep[]): PilotReadinessStep | undefined {
  return steps.find((step) => step.state === "todo");
}

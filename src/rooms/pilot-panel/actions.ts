import { type PilotPanelAction, type PilotPanelSnapshot } from "./contract";
import { PILOT_SKILLS_DIR_REL_PATH } from "./delegation";

export function mapPilotTaskColumn(state: string | null): "queued" | "running" | "checking" | "blocked" | "done" {
  if (!state) return "queued";
  if (state === "accepted") return "done";
  if (state === "running" || state === "starting") return "running";
  if (state === "verifying" || state === "critiquing" || state === "awaiting_merge") return "checking";
  if (state === "blocked" || state === "failed" || state === "needs_human" || state === "quarantined") return "blocked";
  return "queued";
}

function formatSkillCommand(
  providerId: string | null | undefined,
  skillName: string,
  args: string | undefined,
  fallbackText: string,
): string {
  const suffix = args ? ` ${args}` : "";
  if (!providerId || providerId === "claude-code") {
    return `/${skillName}${suffix}`;
  }
  if (providerId === "codex" || providerId === "codex-app") {
    return `$${skillName}${suffix}`;
  }
  return fallbackText;
}

export function buildPilotPanelActions(input: {
  hasWorkspace: boolean;
  configured: boolean;
  skillsSynced: boolean;
  hasContext: boolean;
  hasArchitecture: boolean;
  selectedPlan: PilotPanelSnapshot["plans"]["selected"];
  hasActiveRun: boolean;
  projectId: string | null;
  providerId?: string | null;
  canActivatePm?: boolean;
}): PilotPanelAction[] {
  const actions: PilotPanelAction[] = [];
  const p = input.providerId;
  const cmd = (skill: string, args: string | undefined, fallback: string) =>
    formatSkillCommand(p, skill, args, fallback);
  const add = (
    id: string,
    label: string,
    command: string,
    reason: string,
    group: PilotPanelAction["group"],
    available = input.hasWorkspace,
  ) => {
    actions.push({ id, label, command, reason, group, available });
  };

  if (!input.configured || !input.skillsSynced) {
    add(
      "prepare-project",
      input.configured ? "Обновить скиллы в .bb/skills/" : "Подготовить проект и скиллы",
      "Lane Pilot: установить .agents/pilot/ и скиллы в .bb/skills/",
      "Устанавливает манифест .agents/pilot/config.json и 11 стандартизированных системных скиллов прямо в папку проекта (.bb/skills/) без траты хода модели.",
      "setup",
    );
  }
  add(
    "setup-context",
    "Описать проект (/lp-project-setup)",
    cmd("lp-project-setup", undefined, "Опиши проект и правила по скиллу lp-project-setup"),
    "Изучает стек, пакеты и проверенные команды репозитория и заполняет .agents/pilot/DESCRIPTION.md, rules/base.md и AGENTS.md.",
    "setup",
  );
  add(
    "setup-architecture",
    "Описать архитектуру",
    cmd("lp-project-setup", "architecture", "Опиши архитектуру модулей проекта по скиллу lp-project-setup"),
    "Описывает модули, границы импортов и правила размещения новых файлов в .agents/pilot/ARCHITECTURE.md.",
    "setup",
  );
  add(
    "quality-setup",
    "Настроить Git-хуки",
    "Настроить локальные pre-commit проверки по стеку проекта",
    "Предлагает и настраивает локальные Git-хуки (.husky или lefthook) под существующие команды проверок.",
    "setup",
  );
  add(
    "ci-setup",
    "Настроить CI",
    "Проверить или подготовить конфигурацию CI по стеку проекта",
    "Создаёт или проверяет серверный pipeline проверок (например, GitHub Actions) без выдумывания отсутствующих команд.",
    "setup",
  );

  const selected = input.selectedPlan;
  const allPlanDone = Boolean(selected?.tasks.length && selected.tasks.every((t) => t.state === "done"));
  const somePlanDone = Boolean(selected?.tasks.some((t) => t.state === "done" || t.state === "in_progress"));

  if (selected && selected.tasks.length > 0) {
    if (allPlanDone) {
      add(
        "verify",
        "Проверить реализацию (/lp-verify)",
        cmd("lp-verify", `@${selected.path}`, `Проверь реализацию плана ${selected.path} по скиллу lp-verify`),
        "Сверяет фактический diff, архитектуру и команды typecheck/lint/test/build со всеми пунктами выбранного плана.",
        "next",
      );
    } else {
      add(
        "implement",
        somePlanDone ? "Продолжить план (/lp-implement)" : "Выполнить план (/lp-implement)",
        cmd("lp-implement", `@${selected.path}`, `Выполни план ${selected.path} по скиллу lp-implement`),
        "Выполняет готовые задачи выбранного плана через чистые субтреды или дорожки писателей с проверкой результата.",
        "next",
      );
      add(
        "verify",
        "Проверить текущие правки (/lp-verify)",
        cmd("lp-verify", `@${selected.path}`, `Проверь текущие изменения по плану ${selected.path} (lp-verify)`),
        "Read-only проверка уже внесённых изменений и тестов.",
        "next",
      );
    }
    add(
      "plan",
      "Уточнить план (/lp-plan)",
      cmd("lp-plan", `@${selected.path}`, `Уточни план ${selected.path} по скиллу lp-plan`),
      "Уточняет незавершённые задачи плана с сохранением выполненных чекбоксов.",
      "next",
    );
  } else {
    add(
      "plan",
      "Составить план (/lp-plan)",
      cmd("lp-plan", undefined, "Составь план задачи по скиллу lp-plan"),
      "Исследует код и записывает исполняемый план задач с зависимостями в .agents/pilot/plans/<slug>.md.",
      "next",
    );
    add(
      "explore",
      "Исследовать задачу",
      "Исследовать код и варианты решения до планирования",
      "Read-only разбор затронутых модулей, ограничений и команд проверки в текущем чате.",
      "next",
    );
    add(
      "verify",
      "Проверить изменения (/lp-verify)",
      cmd("lp-verify", undefined, "Проверь текущие изменения репозитория по скиллу lp-verify"),
      "Запускает авторитетную проверку текущих изменений репозитория по правилам и тестам проекта.",
      "next",
    );
  }

  if (!input.hasActiveRun && input.projectId && input.canActivatePm) {
    add(
      "activate-pilot",
      "Открыть PM-чат Lane Pilot",
      "Lane Pilot: запустить координатора рана",
      "Открывает выделенный PM-чат конвейера Lane Pilot для текущего проекта и автоматически подготавливает .bb/skills/.",
      "maintenance",
      true,
    );
  }
  if (input.configured && input.skillsSynced) {
    add(
      "prepare-project",
      "Пересинхронизировать .bb/skills/",
      "Lane Pilot: синхронизировать скиллы проекта",
      "Проверяет и обновляет все 11 стандартизированных скиллов в .bb/skills/ и манифест .agents/pilot/config.json.",
      "maintenance",
    );
  }

  return actions;
}

export function buildPilotActionPrompt(
  actionId: string,
  snapshot: PilotPanelSnapshot,
): { visible: string; context: string } | null {
  const target = snapshot.plans.selected?.path ?? null;
  const providerId = snapshot.session.providerId;
  const rootPrefix = snapshot.project.rootPath ? `${snapshot.project.rootPath.replace(/\/+$/, "")}/` : "";
  const skillPath = (name: string) => `${rootPrefix}${PILOT_SKILLS_DIR_REL_PATH}/${name}/SKILL.md`;
  const meta = JSON.stringify({
    root: snapshot.project.rootPath,
    targetPlan: target,
    delegation: snapshot.delegation.choice,
    skillsDir: `${rootPrefix}${PILOT_SKILLS_DIR_REL_PATH}`,
  });
  switch (actionId) {
    case "setup-context":
      return {
        visible: formatSkillCommand(
          providerId,
          "lp-project-setup",
          undefined,
          "Опиши проект и правила по скиллу lp-project-setup",
        ),
        context: `Контекст кнопки панели Lane Pilot: ${meta}.\nПрочитай файл скилла ${skillPath("lp-project-setup")} и выполни полную настройку контекста проекта в ${snapshot.project.rootPath ?? "корне репозитория"}: изучи стек и реальные команды проверок, заполни .agents/pilot/DESCRIPTION.md, .agents/pilot/rules/base.md, .agents/pilot/ARCHITECTURE.md и обнови управляемый блок в AGENTS.md, сохранив все пользовательские правила. Не пиши продуктовый код.`,
      };
    case "setup-architecture":
      return {
        visible: formatSkillCommand(
          providerId,
          "lp-project-setup",
          "architecture",
          "Опиши архитектуру модулей проекта по скиллу lp-project-setup",
        ),
        context: `Контекст кнопки панели Lane Pilot: ${meta}.\nПрочитай файл скилла ${skillPath("lp-project-setup")} и подробно опиши модульную архитектуру, границы импортов и правила размещения файлов в .agents/pilot/ARCHITECTURE.md на основе фактического дерева кода в ${snapshot.project.rootPath ?? "корне репозитория"}. Не меняй код приложения.`,
      };
    case "quality-setup":
      return {
        visible: "Настрой локальные Git-хуки проверок для этого проекта",
        context: `Контекст кнопки панели Lane Pilot: ${meta}.\nПрочитай ${rootPrefix}AGENTS.md и ${rootPrefix}.agents/pilot/DESCRIPTION.md, проверь существующий стек и предложи/настрой аккуратные pre-commit проверки (.husky или lefthook) только для реально существующих быстрых команд (typecheck/lint). Не затирай существующие хуки.`,
      };
    case "ci-setup":
      return {
        visible: "Проверь или подготовь конфигурацию CI для этого проекта",
        context: `Контекст кнопки панели Lane Pilot: ${meta}.\nПрочитай ${rootPrefix}AGENTS.md и ${rootPrefix}.agents/pilot/DESCRIPTION.md, проверь наличие CI и подготовь/проверь workflow на реальных командах установки, проверки типов, линтера и тестов проекта без выдуманных шагов.`,
      };
    case "explore":
      return {
        visible: "Исследуй текущую задачу по коду проекта до составления плана",
        context: `Контекст кнопки панели Lane Pilot: ${meta}.\nСначала прочитай ${rootPrefix}AGENTS.md, ${rootPrefix}.agents/pilot/DESCRIPTION.md и ${rootPrefix}.agents/pilot/ARCHITECTURE.md (если они заполнены). Проведи read-only исследование затронутых файлов (file:line), сравни подходы и предложи оптимальный вариант без изменения кода.`,
      };
    case "plan":
      return {
        visible: formatSkillCommand(
          providerId,
          "lp-plan",
          target ? `@${target}` : undefined,
          target ? `Уточни план ${target} по скиллу lp-plan` : "Составь план задачи по скиллу lp-plan",
        ),
        context: `Контекст кнопки панели Lane Pilot: ${meta}.\nПрочитай ${skillPath("lp-plan")}, ${rootPrefix}AGENTS.md и ${rootPrefix}.agents/pilot/ARCHITECTURE.md. Составь или уточни исполняемый план задач с графом зависимостей и командами верификации в .agents/pilot/plans/<slug>.md. Код реализации на этом шаге не пиши.`,
      };
    case "implement":
      return {
        visible: formatSkillCommand(
          providerId,
          "lp-implement",
          target ? `@${target}` : undefined,
          target ? `Выполни план ${target} по скиллу lp-implement` : "Выполни план по скиллу lp-implement",
        ),
        context: `Контекст кнопки панели Lane Pilot: ${meta}.\nПрочитай ${skillPath("lp-implement")}, ${rootPrefix}.agents/pilot/config.json и ${rootPrefix}.agents/pilot/skill-context/delegation.md (если есть). Выполни готовые задачи плана с соблюдением границ модулей, делегирования в чистые субтреды на standard tier и обязательной проверкой каждого слоя.`,
      };
    case "verify":
      return {
        visible: formatSkillCommand(
          providerId,
          "lp-verify",
          target ? `@${target}` : undefined,
          target ? `Проверь реализацию плана ${target} по скиллу lp-verify` : "Проверь текущие изменения по скиллу lp-verify",
        ),
        context: `Контекст кнопки панели Lane Pilot: ${meta}.\nПрочитай ${skillPath("lp-verify")}, проверь git status/diff против плана, ${rootPrefix}.agents/pilot/ARCHITECTURE.md и ${rootPrefix}.agents/pilot/rules/base.md, прогони команды проверок проекта и выведи честный отчёт с блоком lp-gate-result.`,
      };
    default:
      return null;
  }
}

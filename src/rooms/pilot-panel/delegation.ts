import { z } from "zod";

export const PILOT_CONFIG_REL_PATH = ".agents/pilot/config.json";
export const PILOT_DELEGATION_CONTEXT_REL_PATH = ".agents/pilot/skill-context/delegation.md";
export const PILOT_DESCRIPTION_REL_PATH = ".agents/pilot/DESCRIPTION.md";
export const PILOT_ARCHITECTURE_REL_PATH = ".agents/pilot/ARCHITECTURE.md";
export const PILOT_RULES_BASE_REL_PATH = ".agents/pilot/rules/base.md";
export const PILOT_PLANS_DIR_REL_PATH = ".agents/pilot/plans";
export const PILOT_SKILLS_DIR_REL_PATH = ".bb/skills";

export const PILOT_STARTER_MARKER = "<!-- lane-pilot:starter-template -->";
export const PILOT_AGENTS_START = "<!-- lane-pilot:project-context:start -->";
export const PILOT_AGENTS_END = "<!-- lane-pilot:project-context:end -->";
export const PILOT_DELEGATION_START = "<!-- lane-pilot:delegation:start -->";
export const PILOT_DELEGATION_END = "<!-- lane-pilot:delegation:end -->";

const safeId = z.string().regex(/^[\w.-]{1,100}$/);
const safeModel = z.string().regex(/^[\w./:@+\-[\]]{1,200}$/);

export const pilotDelegationChoiceSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("pilot-lanes") }).strict(),
  z.object({
    mode: z.literal("bb-subthreads"),
    providerId: safeId,
    model: safeModel,
    reasoning: safeId.optional(),
  }).strict(),
  z.object({ mode: z.literal("self") }).strict(),
]);

export type PilotDelegationChoice = z.infer<typeof pilotDelegationChoiceSchema>;

export function pilotModelSpec(choice: Extract<PilotDelegationChoice, { mode: "bb-subthreads" }>): string {
  const query = choice.reasoning ? `?reasoning=${choice.reasoning}` : "";
  return `${choice.providerId}/${choice.model}${query}`;
}

export function parsePilotModelSpec(raw: unknown): Extract<PilotDelegationChoice, { mode: "bb-subthreads" }> | null {
  const match = typeof raw === "string" ? /^([\w.-]{1,100})\/([^\s?&#]{1,200})(?:\?([\w.=&-]{1,200}))?$/.exec(raw) : null;
  if (!match) return null;
  const params = new URLSearchParams(match[3] ?? "");
  const reasoning = params.get("reasoning");
  if (reasoning !== null && !/^[\w.-]{1,100}$/.test(reasoning)) return null;
  return {
    mode: "bb-subthreads",
    providerId: match[1]!,
    model: match[2]!,
    ...(reasoning ? { reasoning } : {}),
  };
}

/** Replaces or appends a marker-bounded block in-place while leaving all owner bytes outside the markers untouched. */
export function mergePilotManagedBlock(existing: string, startMarker: string, endMarker: string, block: string | null): string {
  const start = existing.indexOf(startMarker);
  const end = start >= 0 ? existing.indexOf(endMarker, start + startMarker.length) : -1;
  const wrapped = block ? `${startMarker}\n${block.trim()}\n${endMarker}` : "";
  if (start >= 0 && end >= start + startMarker.length) {
    const before = existing.slice(0, start);
    const after = existing.slice(end + endMarker.length);
    if (wrapped) return `${before}${wrapped}${after}`;
    const joined = `${before.replace(/[ \t]*\n?$/, "")}${after.replace(/^\n/, before.trim() ? "\n\n" : "")}`;
    return joined.trim() ? `${joined.replace(/\s+$/, "")}\n` : "";
  }
  if (!wrapped) return existing;
  if (!existing.trim()) return `${wrapped}\n`;
  const sep = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return `${existing}${sep}${wrapped}\n`;
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * Generates the project-local delegation contract read by `/lp-implement` and PM coordinators.
 * Always pins `--service-tier 'default'` (Pilot Fast is off; BB Subthreads rule keeps worker sessions clean).
 */
export function pilotDelegationContextBlock(choice: PilotDelegationChoice): string | null {
  if (choice.mode === "self") return null;
  if (choice.mode === "pilot-lanes") {
    return [
      "## Делегирование задач (управляется Lane Pilot)",
      "",
      "Владелец выбрал режим **`pilot-lanes`** (конвейер изолированных worktree-дорожек Lane Pilot с проверками и критиками).",
      "- В PM-чате с инструментами `lane_pilot_dispatch_task` отправляйте готовые задачи (`depends_on` соблюдены, `owns_paths` не пересекаются) в дорожки писателей.",
      "- В обычном чате без активного PM-рана используйте чистые субтреды `bb thread spawn --parent-self --service-tier 'default'` по протоколу `.bb/skills/lp-implement/SKILL.md`.",
    ].join("\n");
  }
  const flags = [
    `--provider ${shellQuote(choice.providerId)}`,
    `--model ${shellQuote(choice.model)}`,
    ...(choice.reasoning ? [`--reasoning-level ${shellQuote(choice.reasoning)}`] : []),
    `--service-tier 'default'`,
  ].join(" ");
  return [
    "## Делегирование кода в чистые субтреды BB (управляется Lane Pilot)",
    "",
    `Владелец проекта выбрал модель \`${pilotModelSpec(choice)}\` на стандартном тарифе (\`service-tier: default\`) для выполнения задач плана \`.agents/pilot/plans/<slug>.md\`. Источник истины — \`.agents/pilot/config.json\` → \`delegation\`.`,
    "",
    "Вы остаётесь координатором: владеете планом, чекбоксами, проверками и коммитами. Для каждой готовой задачи плана:",
    "1. Запишите самодостаточный бриф одной задачи во временный файл (`.bb/chats/$BB_THREAD_ID/tmp/task-<N>-brief.md`):",
    "   - Обязательная шапка: воркер выполняет ровно одну задачу в текущем окружении, НЕ правит файл плана и чекбоксы, НЕ делает git commit/push/checkout, НЕ порождает дочерних агентов.",
    "   - Ссылки для чтения с диска: `AGENTS.md`, `.agents/pilot/ARCHITECTURE.md`, `.agents/pilot/rules/base.md`, `.bb/skills/lp-writer/SKILL.md` и файлы `Owns` задачи.",
    "   - Команды верификации задачи (до 2 локальных раундов исправления существенных ошибок) и формат отчёта (`files_modified`, коды возврата проверок, `docs_recommended`, `commit_recommended`).",
    "2. Проверьте дубликаты: `bb thread list --parent-thread \"$BB_THREAD_ID\" --json` по заголовку `LP · <plan> · Task <N>`.",
    "3. Запустите чистый субтред (BB автоматически создаёт чистую сессию без лишних глобальных скиллов и плагинов):",
    "",
    "```bash",
    `bb thread spawn --project "$BB_PROJECT_ID" --environment "$BB_ENVIRONMENT_ID" --parent-self --lifecycle-owner-thread "$BB_THREAD_ID" --parent-notifications off ${flags} --title 'LP · <plan> · Task <N>' --prompt-file <brief> --json`,
    "```",
    "",
    "4. Дождитесь завершения (`bb thread wait <id> --status idle --timeout 8m`), прочитайте `bb thread output <id>`, проверьте `git diff` и запустите верификацию задачи сами перед отметкой `- [x]`.",
  ].join("\n");
}

export function pilotAgentsContextBlock(): string {
  return [
    "## Lane Pilot — проектный контекст и локальные скиллы",
    "",
    "- Манифест и настройки делегирования проекта: `.agents/pilot/config.json`.",
    "- Описание стека и проверенных команд (`typecheck`, `lint`, `test`, `build`): `.agents/pilot/DESCRIPTION.md`.",
    "- Архитектура модулей и границы импортов: `.agents/pilot/ARCHITECTURE.md`.",
    "- Базовые конвенции кода проекта: `.agents/pilot/rules/base.md`.",
    "- Планы задач с зависимостями: `.agents/pilot/plans/<slug>.md`.",
    "- Стандартизированные системные скиллы лежат прямо внутри проекта в `.bb/skills/` (`lane-pilot`, `lp-project-setup`, `lp-plan`, `lp-implement`, `lp-verify`, `lp-writer`, `lp-docs`, `lane-memory`, `project-life`, `lp-agentic-discipline`, `karpathy-guidelines`), поэтому доступны на любой машине и в чистых субтредах.",
  ].join("\n");
}

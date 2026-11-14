// Region 23 · Templates, references, contexts — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
// A template or a reference of this region is text an agent is handed. The mutations here change WHO gets it (the role a method or a step is
// given to), WHEN (the switch or the situation that selects it) or what the code does with the FILLED form (a refusal, a loop back, a deny
// tag the inventory must know) — never a word of the text. The behaviour tests are tests/sma/four-proofs-r23-a.test.ts and the tagged
// tests beside it. A reference that writes no row to the hub database is traced by its own prove() line in scripts/lp_drill/scenes/sma_r23.py.
import { distort, drill, flip, type RegionEvidence, voidIsHave, voidStays, wfRun, wfStep, wrongTarget } from "./types";

const STAGES = "src/rooms/phase/stages.ts";
const ACTIONS = "src/rooms/workflow/server/workflow-project-actions.ts";

export default {
  n1625: { voidReview: voidStays("имён /gsd-* в Lane Pilot не было, старых фаз для моста нет; флаг установщика ушёл вместе с Claude Lane") },
  n1626: { voidReview: voidStays("меню стилей обсуждения (batch, auto, power…) ничего не охраняет; у фазы одна рубрика обсуждения (n1307)") },
  n1627: { voidReview: voidIsHave("ворота дрейфа и после слияния: исполнитель в своей worktree, слияние отказывает BASE_MOVED, если main сдвинулся мимо проверенного пакета; проверка после слияния в verification/finish"),
    mutation: flip("src/rooms/verification/git-integrate/merge.ts", "if(input.baseInHead&&before&&!(await git(input.worktreePath", "if(input.baseInHead&&before&&(await git(input.worktreePath"), trace: drill("sma_r23") },
  n1628: { voidReview: voidStays("уровни подробности справки — выбор стиля; справка CLI одна и перечисляет все глаголы с примером (n1248)") },
  n1629: { mutation: flip("src/rooms/phase/logic/gates.ts", "if ((plan.rounds ?? 0) >= PLAN_ROUNDS_MAX && plan.critique?.decision !== \"approve\")", "if ((plan.rounds ?? 0) >= PLAN_ROUNDS_MAX && plan.critique?.decision === \"approve\")"), trace: drill("sma_r23") },
  n1630: { mutation: distort("src/rooms/session-hooks/logic.ts", "{ id: \"subagent-cap\", matcher", "{ id: \"subagent-limit\", matcher"), trace: drill("sma_r23") },
  n1631: { mutation: flip("workflows/lp.plan.json", "\"when\": \"!lint.ok && visits('lint') < 3 && visits('plan') < 4\"", "\"when\": \"lint.ok && visits('lint') < 3 && visits('plan') < 4\""), trace: [wfRun("lp.plan"), drill("sma_r23")] },
  n1632: { voidReview: voidIsHave("способ мышления по ролям задают методы ролей: планировщик, аналитик, критик плана и кода, научная отладка, аудитор"),
    mutation: wrongTarget("src/rooms/critique/role-method.ts", "case \"planner\": return PLANNER_METHOD;", "case \"planner\": return ANALYST_METHOD;"), trace: drill("sma_r23") },
  n1633: { mutation: flip("workflows/web-research.json", "\"when\": \"!check.citation_ok && visits('report') < 2\"", "\"when\": \"check.citation_ok && visits('report') < 2\""), trace: [wfRun("web-research"), drill("sma_r23")] },
  n1634: { mutation: flip(STAGES, "notes ? EXECUTOR_RULE_EXAMPLE : \"\",", "!notes ? EXECUTOR_RULE_EXAMPLE : \"\","), trace: drill("sma_r23") },
  n1635: { mutation: flip("src/rooms/writer/server/writer-task.ts", "(liveFolder ? LIVE_FOLDER_SETUP_LINE : line)", "(!liveFolder ? LIVE_FOLDER_SETUP_LINE : line)"), trace: drill("sma_r23") },
  n1636: { voidReview: voidIsHave("вертикальный срез и нарезка историй: граф mvp-phase режет историю на куски плана с проверкой, lp.plan — на задачи с одним исходом"),
    mutation: flip("workflows/mvp-phase.json", "\"when\": \"split_check.verdict == 'rework' && visits('story') < 2\"", "\"when\": \"split_check.verdict == 'rework' && visits('story') < 1\""), trace: drill("sma_r23") },
  n1637: { mutation: wrongTarget("workflows/lp.draw.json", "\"id\": \"check\",\n      \"type\": \"agent\",\n      \"role\": \"plan-critic\",", "\"id\": \"check\",\n      \"type\": \"agent\",\n      \"role\": \"specialist:design-lead\","), trace: drill("sma_r23") },
  n1638: { mutation: distort(STAGES, "draw by the shared drawing rules into the phase's design folder — ${DRAWING_RULES}`", "draw by the shared drawing rules into the phase's design folder`"), trace: drill("sma_r23") },
  n1639: { mutation: flip("workflows/ai-integration-phase.json", "\"when\": \"!check.ok && visits('check') < 2\"", "\"when\": \"!check.ok && visits('check') < 1\""), trace: drill("sma_r23") },
  n1640: { mutation: flip("workflows/debug.json", "investigate.confidence >= 40", "investigate.confidence < 40"), trace: [wfRun("debug"), drill("sma_r23")] },
  n1641: { mutation: flip("workflows/lp.plan.json", "\"skip_when\": \"!$inputs.validation || $mode == 'quick'\"", "\"skip_when\": \"!$inputs.validation && $mode == 'quick'\""), trace: [wfStep("lp.plan", "strategy"), drill("sma_r23")] },
  n1642: { mutation: flip("src/rooms/tasks/rails.ts", "return words.length > 0 && words.every((word) => CONSENT_WORDS.has(word));", "return words.length > 0 && words.some((word) => CONSENT_WORDS.has(word));"), trace: drill("sma_r23") },
  n1643: { mutation: flip("packages/memory-core/src/candidates.ts", "if(INSTRUCTION_INJECTION.test(content))return", "if(!INSTRUCTION_INJECTION.test(content))return"), trace: drill("sma_r23") },
  n1644: { mutation: wrongTarget("packages/models/src/role-models.ts", "const own = tableRowAt(settings, row.id);", "const own = tableRowAt(settings, \"errand\");"), trace: drill("sma_r23") },
  n1645: { voidReview: voidIsHave("схема профиля (стек, тесты, выпуск, стиль работы) и порядок онбординга — шаги project-start, пишущие профиль"),
    mutation: flip("src/rooms/anamnesis/profile.ts", "if (value.length > PROFILE_VALUE_MAX) return", "if (value.length < PROFILE_VALUE_MAX) return"), trace: drill("sma_r23") },
  n1646: { mutation: distort("src/rooms/contracts/bundled-agents.json", "\"skills\": [\n      \"lane-pilot\"\n    ],\n    \"mcpServers\": [],\n    \"omittedNativeFields\"", "\"skills\": [\n      \"tavily\"\n    ],\n    \"mcpServers\": [],\n    \"omittedNativeFields\""), trace: drill("sma_r23") },
  n1647: { voidReview: voidStays("выбор из трёх форм SUMMARY.md ничего не охраняет; пишется одна короткая форма (templateFill, n1574)") },
  n1648: { voidReview: voidStays("шаблоны project-onboard убраны 2026-10-30, страницы по коду пишет ночной граф docs; читателя фиксированных семи форм карты кода нет") },
  n1649: { voidReview: voidStays("шаблоны форм исследования убраны 2026-10-30; анализ пишет lp.analyze, а стек, возможности и подводные камни отдельной формой не держатся") },
  n1650: { mutation: flip(STAGES, "const forecast = notes && task.forecast", "const forecast = !notes && task.forecast"), trace: drill("sma_r23") },
  n1651: { mutation: flip(ACTIONS, "&& !current.content.includes(\"Developer preferences\"))", "&& current.content.includes(\"Developer preferences\"))"), trace: drill("sma_r23") },
  n1652: { mutation: flip(ACTIONS, "/^INS-[0-9a-f]{8}$/.test(str(ins.id))", "!/^INS-[0-9a-f]{8}$/.test(str(ins.id))"), trace: [wfStep("milestone-close", "record"), drill("sma_r23")] },
} satisfies RegionEvidence;

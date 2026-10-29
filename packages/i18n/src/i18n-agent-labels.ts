/** Picker names for agents ported from Claude Lane (2026-10-29). A separate module so the key survives export. */
export const agentLabelEn = {
  agentDisplayAdvisorResearcher: "Advisor",
  agentDisplayAiResearcher: "AI researcher",
  agentDisplayAnimator: "Animator",
  agentDisplayDocClassifier: "Doc classifier",
  agentDisplayDomainResearcher: "Domain researcher",
  agentDisplayEvalAuditor: "Eval auditor",
  agentDisplayEvalPlanner: "Eval planner",
  agentDisplayFrameworkSelector: "Model selector",
  agentDisplayMempalaceCurator: "Memory curator",
  agentDisplayNyquistAuditor: "Check auditor",
  agentDisplayUiResearcher: "UI researcher",
};

export const agentLabelRu: { [K in keyof typeof agentLabelEn]: string } = {
  agentDisplayAdvisorResearcher: "Советник",
  agentDisplayAiResearcher: "Исследователь моделей",
  agentDisplayAnimator: "Аниматор",
  agentDisplayDocClassifier: "Классификатор документов",
  agentDisplayDomainResearcher: "Исследователь области",
  agentDisplayEvalAuditor: "Аудитор оценки",
  agentDisplayEvalPlanner: "Планировщик оценки",
  agentDisplayFrameworkSelector: "Выбор модели",
  agentDisplayMempalaceCurator: "Куратор памяти",
  agentDisplayNyquistAuditor: "Аудитор проверок",
  agentDisplayUiResearcher: "Исследователь интерфейса",
};

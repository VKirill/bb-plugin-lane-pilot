import { roleNameEn, roleNameRu } from "./role-names";
/** Picker names for agents ported from Claude Lane (2026-10-29). A separate module so the key survives export. */
export const agentLabelEn = {
  agentDisplayAdvisorResearcher: roleNameEn("advisor-researcher"),
  agentDisplayAiResearcher: roleNameEn("ai-researcher"),
  agentDisplayAnimator: roleNameEn("animator"),
  agentDisplayDocClassifier: roleNameEn("doc-classifier"),
  agentDisplayDomainResearcher: roleNameEn("domain-researcher"),
  agentDisplayEvalAuditor: roleNameEn("eval-auditor"),
  agentDisplayEvalPlanner: roleNameEn("eval-planner"),
  agentDisplayFrameworkSelector: roleNameEn("framework-selector"),
  agentDisplayMempalaceCurator: roleNameEn("mempalace-curator"),
  agentDisplayNyquistAuditor: roleNameEn("nyquist-auditor"),
  agentDisplayUiResearcher: roleNameEn("ui-researcher"),
  agentDisplayLead: roleNameEn("lead"),
  agentDisplayGrowthMarketer: roleNameEn("growth-marketer"),
};

export const agentLabelRu: { [K in keyof typeof agentLabelEn]: string } = {
  agentDisplayAdvisorResearcher: roleNameRu("advisor-researcher"),
  agentDisplayAiResearcher: roleNameRu("ai-researcher"),
  agentDisplayAnimator: roleNameRu("animator"),
  agentDisplayDocClassifier: roleNameRu("doc-classifier"),
  agentDisplayDomainResearcher: roleNameRu("domain-researcher"),
  agentDisplayEvalAuditor: roleNameRu("eval-auditor"),
  agentDisplayEvalPlanner: roleNameRu("eval-planner"),
  agentDisplayFrameworkSelector: roleNameRu("framework-selector"),
  agentDisplayMempalaceCurator: roleNameRu("mempalace-curator"),
  agentDisplayNyquistAuditor: roleNameRu("nyquist-auditor"),
  agentDisplayUiResearcher: roleNameRu("ui-researcher"),
  agentDisplayLead: roleNameRu("lead"),
  agentDisplayGrowthMarketer: roleNameRu("growth-marketer"),
};

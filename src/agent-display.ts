import type { I18nKey } from "../i18n";

export const STOCK_AGENT_SEED_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "dev-orchestrator": "Lane Pilot development orchestrator",
  "copy-lead": "Lane Pilot copy lead",
  "seo-specialist": "Lane Pilot SEO specialist",
  "design-lead": "Lane Pilot design lead",
  "project-onboarder": "Lane Pilot project onboarder",
  tavily: "Lane Pilot Tavily research agent",
  "workflow-architect": "Lane Pilot workflow architect",
};

const BUNDLED_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  "dev-orchestrator": "Development coordinator",
  "copy-lead": "Copy editor",
  "seo-specialist": "SEO specialist",
  "design-lead": "Designer",
  "project-onboarder": "Project onboarding",
  tavily: "Researcher",
  "workflow-architect": "Workflow architect",
};

const STOCK_LABEL_KEYS: Readonly<Record<string, I18nKey>> = {
  "dev-orchestrator": "agentDisplayDevOrchestrator",
  "copy-lead": "agentDisplayCopyLead",
  "seo-specialist": "agentDisplaySeoSpecialist",
  "design-lead": "agentDisplayDesignLead",
  "project-onboarder": "agentDisplayProjectOnboarder",
  tavily: "agentDisplayTavily",
  "workflow-architect": "agentDisplayWorkflowArchitect",
};

function stockDescriptions(id: string): string[] {
  return [BUNDLED_DISPLAY_NAMES[id], STOCK_AGENT_SEED_DESCRIPTIONS[id]].filter(
    (value): value is string => Boolean(value),
  );
}

export function agentPickerLabel(
  agent: { id: string; description: string },
  translate: (key: I18nKey) => string,
): string {
  const key = STOCK_LABEL_KEYS[agent.id];
  if (key && stockDescriptions(agent.id).includes(agent.description.trim())) {
    return translate(key);
  }
  return agent.description;
}

const STOCK_CHART: Readonly<Record<string, 1 | 2 | 3 | 4 | 5>> = {
  "dev-orchestrator": 1,
  "copy-lead": 2,
  "seo-specialist": 3,
  "design-lead": 4,
  "project-onboarder": 5,
  tavily: 3,
  "workflow-architect": 5,
};

export function agentBadgeChart(id: string): 1 | 2 | 3 | 4 | 5 {
  const stock = STOCK_CHART[id];
  if (stock) return stock;
  let sum = 0;
  for (let i = 0; i < id.length; i += 1) sum += id.charCodeAt(i);
  return ((sum % 5) + 1) as 1 | 2 | 3 | 4 | 5;
}

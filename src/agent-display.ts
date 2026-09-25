import type { I18nKey } from "../i18n";

export const STOCK_AGENT_SEED_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "dev-orchestrator": "Lane Pilot development orchestrator",
  "copy-lead": "Lane Pilot copy lead",
  "seo-specialist": "Lane Pilot SEO specialist",
  "design-lead": "Lane Pilot design lead",
  "project-onboarder": "Lane Pilot project onboarder",
  tavily: "Lane Pilot Tavily research agent",
};

const BUNDLED_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  "dev-orchestrator": "Development coordinator",
  "copy-lead": "Copy editor",
  "seo-specialist": "SEO specialist",
  "design-lead": "Designer",
  "project-onboarder": "Project onboarding",
  tavily: "Researcher",
};

const STOCK_LABEL_KEYS: Readonly<Record<string, I18nKey>> = {
  "dev-orchestrator": "agentDisplayDevOrchestrator",
  "copy-lead": "agentDisplayCopyLead",
  "seo-specialist": "agentDisplaySeoSpecialist",
  "design-lead": "agentDisplayDesignLead",
  "project-onboarder": "agentDisplayProjectOnboarder",
  tavily: "agentDisplayTavily",
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

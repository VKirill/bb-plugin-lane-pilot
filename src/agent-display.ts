import type { I18nKey } from "../i18n";

export const STOCK_AGENT_SEED_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "dev-orchestrator": "Lane Pilot development orchestrator",
  "copy-lead": "Lane Pilot copy lead",
  "seo-specialist": "Lane Pilot SEO specialist",
  "design-lead": "Lane Pilot design lead",
  "project-onboarder": "Lane Pilot project onboarder",
  tavily: "Lane Pilot Tavily research agent",
};

const STOCK_LABEL_KEYS: Readonly<Record<string, I18nKey>> = {
  "dev-orchestrator": "agentDisplayDevOrchestrator",
  "copy-lead": "agentDisplayCopyLead",
  "seo-specialist": "agentDisplaySeoSpecialist",
  "design-lead": "agentDisplayDesignLead",
  "project-onboarder": "agentDisplayProjectOnboarder",
  tavily: "agentDisplayTavily",
};

export function agentPickerLabel(
  agent: { id: string; description: string },
  translate: (key: I18nKey) => string,
): string {
  const seed = STOCK_AGENT_SEED_DESCRIPTIONS[agent.id];
  const key = STOCK_LABEL_KEYS[agent.id];
  if (seed !== undefined && key && agent.description.trim() === seed) {
    return translate(key);
  }
  return agent.description;
}

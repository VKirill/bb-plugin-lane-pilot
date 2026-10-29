import type { I18nKey } from "@lane-pilot/i18n";

export const STOCK_AGENT_SEED_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "dev-orchestrator": "Lane Pilot development orchestrator",
  "copy-lead": "Lane Pilot copy lead",
  "seo-specialist": "Lane Pilot SEO specialist",
  "design-lead": "Lane Pilot design lead",
  "project-onboarder": "Lane Pilot project onboarder",
  tavily: "Lane Pilot Tavily research agent",
  "workflow-architect": "Lane Pilot workflow architect",
  "video-lead": "Lane Pilot video lead",
  "advisor-researcher": "Lane Pilot advisor researcher",
  "ai-researcher": "Lane Pilot AI researcher",
  "animator": "Lane Pilot animator",
  "doc-classifier": "Lane Pilot doc classifier",
  "domain-researcher": "Lane Pilot domain researcher",
  "eval-auditor": "Lane Pilot eval auditor",
  "eval-planner": "Lane Pilot eval planner",
  "framework-selector": "Lane Pilot model selector",
  "mempalace-curator": "Lane Pilot memory curator",
  "nyquist-auditor": "Lane Pilot check auditor",
  "ui-researcher": "Lane Pilot UI researcher",
};

const BUNDLED_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  "dev-orchestrator": "Development coordinator",
  "copy-lead": "Copy editor",
  "seo-specialist": "SEO specialist",
  "design-lead": "Designer",
  "project-onboarder": "Project onboarding",
  tavily: "Researcher",
  "workflow-architect": "Workflow architect",
  "video-lead": "Video",
  "advisor-researcher": "Advisor",
  "ai-researcher": "AI researcher",
  "animator": "Animator",
  "doc-classifier": "Doc classifier",
  "domain-researcher": "Domain researcher",
  "eval-auditor": "Eval auditor",
  "eval-planner": "Eval planner",
  "framework-selector": "Model selector",
  "mempalace-curator": "Memory curator",
  "nyquist-auditor": "Check auditor",
  "ui-researcher": "UI researcher",
};

const STOCK_LABEL_KEYS: Readonly<Record<string, I18nKey>> = {
  "dev-orchestrator": "agentDisplayDevOrchestrator",
  "copy-lead": "agentDisplayCopyLead",
  "seo-specialist": "agentDisplaySeoSpecialist",
  "design-lead": "agentDisplayDesignLead",
  "project-onboarder": "agentDisplayProjectOnboarder",
  tavily: "agentDisplayTavily",
  "workflow-architect": "agentDisplayWorkflowArchitect",
  "video-lead": "agentDisplayVideoLead",
  // (2026-10-29 lane-stack port) The exported I18nKey union is too large to accept keys added after it. These are real keys in i18n-agent-labels.ts.
  "advisor-researcher": "agentDisplayAdvisorResearcher" as unknown as I18nKey,
  "ai-researcher": "agentDisplayAiResearcher" as unknown as I18nKey,
  "animator": "agentDisplayAnimator" as unknown as I18nKey,
  "doc-classifier": "agentDisplayDocClassifier" as unknown as I18nKey,
  "domain-researcher": "agentDisplayDomainResearcher" as unknown as I18nKey,
  "eval-auditor": "agentDisplayEvalAuditor" as unknown as I18nKey,
  "eval-planner": "agentDisplayEvalPlanner" as unknown as I18nKey,
  "framework-selector": "agentDisplayFrameworkSelector" as unknown as I18nKey,
  "mempalace-curator": "agentDisplayMempalaceCurator" as unknown as I18nKey,
  "nyquist-auditor": "agentDisplayNyquistAuditor" as unknown as I18nKey,
  "ui-researcher": "agentDisplayUiResearcher" as unknown as I18nKey,
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
  "video-lead": 4,
  "advisor-researcher": 2,
  "ai-researcher": 3,
  "animator": 4,
  "doc-classifier": 5,
  "domain-researcher": 1,
  "eval-auditor": 2,
  "eval-planner": 3,
  "framework-selector": 5,
  "mempalace-curator": 1,
  "nyquist-auditor": 2,
  "ui-researcher": 4,
};

export function agentBadgeChart(id: string): 1 | 2 | 3 | 4 | 5 {
  const stock = STOCK_CHART[id];
  if (stock) return stock;
  let sum = 0;
  for (let i = 0; i < id.length; i += 1) sum += id.charCodeAt(i);
  return ((sum % 5) + 1) as 1 | 2 | 3 | 4 | 5;
}

/** One row of the composer picker. `custom` and `kind` come from the agent registry; both may be absent. */
export type PickableAgent = {
  id: string;
  description: string;
  custom?: boolean;
  kind?: "coordinator" | "specialist" | "internal";
};

const COORDINATOR_ID = "dev-orchestrator";
const INTERNAL_IDS: ReadonlySet<string> = new Set(["project-onboarder"]);

export function agentKind(agent: Pick<PickableAgent, "id" | "kind">): "coordinator" | "specialist" | "internal" {
  if (agent.kind) return agent.kind;
  if (agent.id === COORDINATOR_ID) return "coordinator";
  return INTERNAL_IDS.has(agent.id) ? "internal" : "specialist";
}

/** The name on the composer: the coordinator is «Lane Pilot» itself, every other agent keeps its own name. */
export function composerAgentLabel(
  agent: { id: string; description: string; kind?: PickableAgent["kind"] },
  translate: (key: I18nKey) => string,
): string {
  if (agentKind(agent) === "coordinator") return translate("panelTitle");
  return agentPickerLabel(agent, translate);
}

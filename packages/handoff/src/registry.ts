/** An agent as the host plugin knows it; `prompt` is its instruction body, from which the first paragraph is the summary. */
export type AgentDefinition = {
  id: string;
  displayName?: string;
  description?: string;
  prompt?: string;
  skills?: readonly string[];
  tools?: readonly string[];
};

export type Capability = {
  agentId: string;
  displayName: string;
  summary: string;
  skills: readonly string[];
  terms: ReadonlySet<string>;
};

export type CapabilityRegistry = readonly Capability[];

const SUMMARY_MAX = 400;

function tokens(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? [];
}

function firstParagraph(prompt: string | undefined): string {
  if (!prompt) return "";
  const body = prompt.replace(/^---[\s\S]*?---\s*/, "");
  const paragraph = body.split(/\n\s*\n/).map((part) => part.trim()).find((part) => part.length > 0 && !part.startsWith("#")) ?? "";
  return paragraph.replace(/\s+/g, " ").slice(0, SUMMARY_MAX);
}

export function buildCapabilityRegistry(agents: readonly AgentDefinition[]): CapabilityRegistry {
  return agents.map((agent) => {
    const summary = agent.description?.trim() || firstParagraph(agent.prompt);
    const skills = agent.skills ?? [];
    const terms = new Set([
      ...tokens(agent.id.replace(/[:_-]/g, " ")),
      ...tokens(agent.displayName ?? ""),
      ...tokens(summary),
      ...skills.flatMap((skill) => tokens(skill.replace(/[:_-]/g, " "))),
    ]);
    return { agentId: agent.id, displayName: agent.displayName ?? agent.id, summary, skills, terms };
  });
}

export type RecipientChoice = { agentId: string; score: number; reason: "mentioned" | "matched" } | null;

/**
 * Picks who should get a request. An explicit `@agent` mention wins; otherwise the agent whose
 * summary and skills share the most terms with the request, provided at least one term matched.
 */
export function chooseRecipient(registry: CapabilityRegistry, request: string): RecipientChoice {
  const mention = request.match(/@([\p{L}\p{N}:_-]+)/u)?.[1]?.toLowerCase();
  if (mention) {
    const named = registry.find((item) => item.agentId.toLowerCase() === mention || item.agentId.toLowerCase().endsWith(`:${mention}`));
    if (named) return { agentId: named.agentId, score: Number.POSITIVE_INFINITY, reason: "mentioned" };
  }
  const words = new Set(tokens(request));
  let best: RecipientChoice = null;
  for (const item of registry) {
    let score = 0;
    for (const word of words) {
      if (item.terms.has(word)) score += item.skills.some((skill) => skill.toLowerCase().includes(word)) ? 2 : 1;
    }
    if (score > 0 && (!best || score > best.score)) best = { agentId: item.agentId, score, reason: "matched" };
  }
  return best;
}

/** One line per agent, for a PM prompt that has to choose a recipient itself. */
export function describeRegistry(registry: CapabilityRegistry): string {
  return registry.map((item) => `- ${item.agentId} (${item.displayName}): ${item.summary || "no summary"}${item.skills.length ? ` Skills: ${item.skills.join(", ")}.` : ""}`).join("\n");
}

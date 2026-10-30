import type { RouterCard } from "@lane-pilot/workflow-engine";
import { parseSandboxUnsafePatterns } from "../critique";

/**
 * The policy manifest of one route candidate (JevRouter's permissions/risk/availability): what the workflow needs to run
 * and what it can break. A candidate the project or the task does not allow is cut by this code before Jev is asked — the
 * judgment picks only among the permissible. When nothing remains the route is escalated to the model step.
 */

export type RouteRisk = "low" | "medium" | "high";
const RISK_ORDER: Record<RouteRisk, number> = { low: 0, medium: 1, high: 2 };

export type RoutePolicy = {
  /** Above this level a workflow is not offered (project setting `route.max_risk`). */
  maxRisk?: RouteRisk;
  /** A non-empty `secrets.allow` list: a required secret it leaves out forbids the workflow. */
  secretsAllow?: readonly string[] | null;
};

export type CandidateManifest = {
  /** Every permission the workflow asks for, as `kind:name` (`secret:TAVILY_API_KEY`, `platform:threads`). */
  permissions: string[];
  /** What a wrong run can break: accounts, money or sign-ins (secrets, platforms, a browser session) are `high`; needing a machine, a tool or a plugin is `medium`; self-contained work is `low`. */
  risk: RouteRisk;
};

/** An optional `requires.secrets` entry (`NAME (optional …)`): it never forbids (the same test as stateProblem). */
const OPTIONAL = /\(|optional|по желанию|только при|only/i;
const secretName = (raw: string): string | null => {
  const name = /^[A-Z][A-Z0-9_]+/.exec(raw)?.[0];
  return name && !OPTIONAL.test(raw) ? name : null;
};

export function manifestOf(card: RouterCard): CandidateManifest {
  const { requires } = card;
  const permissions = [
    ...requires.plugins.map((name) => `plugin:${name}`), ...requires.skills.map((name) => `skill:${name}`),
    ...requires.secrets.map((raw) => `secret:${secretName(raw) ?? raw}`), ...requires.machines.map((name) => `machine:${name}`),
    ...requires.mcp.map((name) => `mcp:${name}`), ...requires.tools.map((name) => `tool:${name}`),
    ...requires.platforms.map((name) => `platform:${name}`), ...(requires.browserSession ? ["browser:session"] : []),
  ];
  const risk: RouteRisk =
    requires.secrets.some((raw) => secretName(raw) !== null) || requires.platforms.length > 0 || requires.browserSession ? "high"
    : requires.machines.length > 0 || requires.tools.length > 0 || requires.mcp.length > 0 ? "medium" : "low";
  return { permissions, risk };
}

/** Why this candidate cannot run here under the project's route policy; null when allowed. */
export function policyProblem(card: RouterCard, policy: RoutePolicy): string | null {
  const manifest = manifestOf(card);
  if (policy.maxRisk && RISK_ORDER[manifest.risk] > RISK_ORDER[policy.maxRisk]) return `risk ${manifest.risk} is above the allowed ${policy.maxRisk}`;
  const allow = policy.secretsAllow;
  if (allow && allow.length && !allow.includes("*")) {
    for (const raw of card.requires.secrets) {
      const name = secretName(raw);
      if (name && !allow.includes(name)) return `secret ${name} is left out of the project's secrets.allow`;
    }
  }
  return null;
}

/** The candidates the policy allows, and why each refused one was refused. */
export function filterByPolicy(candidates: readonly RouterCard[], policy: RoutePolicy): { allowed: RouterCard[]; rejected: Array<{ id: string; reason: string }> } {
  const allowed: RouterCard[] = [], rejected: Array<{ id: string; reason: string }> = [];
  for (const card of candidates) {
    const problem = policyProblem(card, policy);
    if (problem) rejected.push({ id: card.id, reason: `policy: ${problem}` });
    else allowed.push(card);
  }
  return { allowed, rejected };
}

const RISKS: readonly string[] = ["low", "medium", "high"];

/** The project's route policy from its settings: `route.max_risk` and `secrets.allow`. */
export function routePolicyOf(settings: Record<string, unknown>): RoutePolicy {
  const risk = typeof settings["route.max_risk"] === "string" && RISKS.includes(settings["route.max_risk"]) ? settings["route.max_risk"] as RouteRisk : undefined;
  const allow = parseSandboxUnsafePatterns(settings["secrets.allow"]);
  return { ...(risk ? { maxRisk: risk } : {}), secretsAllow: allow.length ? allow : null };
}

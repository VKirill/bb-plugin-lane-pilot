import { z } from "zod";
import { createHash } from "node:crypto";
import { LANE_PILOT_PM_SESSION, NATIVE_LP_BRIDGE_PM_TOOLS } from "../native-agent";
import { flatParameters, unionMembers, withSignatures } from "../platform/server";
import { pmRulesBlock, pmRulesOf, ruleBudget, type Db, type PmRule } from "../learning";

/**
 * The PM surface the replay runs against: the system prompt plus the bridge tools as the stub publishes them. Arm A is
 * the live surface (the prompt's rules block holds every PM rule in force); a candidate arm appends the rule on trial
 * exactly the way pm-rules.ts injects it (one `- <rule>` line in the same block).
 */
export type PmSurface = { prompt: string; tools: Array<{ name: string; description: string; instructions?: string; input: unknown }> };

type ToolBook = ReadonlyMap<string, { name: string; description?: string; instructions?: string; parameters?: z.ZodType }>;

/** The PM bridge tools as the MCP stub publishes them (what the model sees through BB). */
export function pmSurfaceTools(registered: ToolBook): PmSurface["tools"] {
  const out: PmSurface["tools"] = [];
  for (const name of NATIVE_LP_BRIDGE_PM_TOOLS) {
    const tool = registered.get(name);
    if (!tool) continue;
    const members = tool.parameters ? unionMembers(tool.parameters) : null;
    const input = tool.parameters
      ? members ? flatParameters(tool.name, members) : z.toJSONSchema(tool.parameters, { io: "input", unrepresentable: "any" })
      : { type: "object" };
    out.push({
      name,
      description: tool.description ?? "",
      instructions: members ? withSignatures(tool.instructions ?? "", members) : tool.instructions,
      input,
    });
  }
  return out;
}

/** The system prompt of one arm: the PM session text plus the rules block the PM would get. `extraRules` are trial/candidate rules appended at the end of the block (their natural order). */
export function armPrompt(db: Db, projectId: string, extraRules: readonly Pick<PmRule, "rule">[] = []): string {
  let block = "";
  try {
    const rules = pmRulesOf(db, projectId, []);
    block = pmRulesBlock(rules, ruleBudget("pm")).text;
    if (extraRules.length) {
      const extra = extraRules.map((rule) => `- ${rule.rule}`).join("\n");
      block = block ? `${block}\n${extra}` : `\n\nRules the owner taught in this project (they came from his corrections; follow them in planning, task contracts, reviews, merges, deploys and in what you ask him):\n${extra}`;
    }
  } catch { block = ""; }
  return `${LANE_PILOT_PM_SESSION}${block}`;
}

/** The arm id a result is recorded under: a prompt fingerprint plus the rule ids it proves ("" for the plain current arm). */
export function armId(prompt: string, ruleIds: readonly string[] = []): string {
  const hash = createHash("sha256").update(prompt).digest("hex").slice(0, 10);
  return ruleIds.length ? `cand:${ruleIds.join("+")}:${hash}` : `base:${hash}`;
}

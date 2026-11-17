import type { Phase } from "../logic";

/** SECURITY.md: the threat model the plan gate (threatGap) asks for when the analysis names a security risk. */
export function securityDoc(phase: Pick<Phase, "title" | "goal">, risks: readonly string[]): string {
  return [
    `# Threat model — ${phase.title}`, "", `Goal: ${phase.goal}`, "",
    "## Security risks named by the analysis", ...risks.map((risk) => `- ${risk}`), "",
    "## What the plan must hold", "- every piece that touches these risks names them in its acceptance and carries a check for them", "- no secret, credential or permission is widened without a check that would fail if it were", "",
    "Written by Lane Pilot from the analysis (lp.analyze); the planner and the plan critic read it with CONTEXT.md.",
  ].join("\n");
}

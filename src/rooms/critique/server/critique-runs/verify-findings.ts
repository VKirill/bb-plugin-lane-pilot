import { criticAcrossFamilies } from "../../critic-pair";
import type { CriticCatalog, Pair } from "../../critic-pair";
import { findingId } from "../../code-critique";
import type { CodeCritiqueResult } from "../../code-critique";
import { applyVerifier, parseVerifierAnswer, seriousFindings, verifierPrompt } from "../../code-verifier";
import type { VerifierSummary } from "../../code-verifier";

export type VerifierOutcome = VerifierSummary | { skipped: string } | { failed: string };

/**
 * One independent check of the critic's critical and high findings by a model of another family than the critic (the cross-family peer of
 * critic-pair.ts). `run` sends the prompt to that pair and returns the answer text; it owns the thread and its timeout. Anything that goes wrong
 * (no peer on offer, a timeout, an unreadable answer) leaves the critic's verdict exactly as it was and says why in the outcome.
 */
export async function verifySeriousFindings(input: {
  critique: CodeCritiqueResult; critic: Pair; effort: string; tier: "fast" | "standard"; catalog: CriticCatalog;
  task: unknown; workspace?: string; run: (prompt: string, pair: Pair) => Promise<string>;
}): Promise<{ critique: CodeCritiqueResult; outcome: VerifierOutcome | null }> {
  const asked = seriousFindings(input.critique);
  if (!asked.length) return { critique: input.critique, outcome: null };
  try {
    const peer = await criticAcrossFamilies({ critic: input.critic, writer: input.critic, effort: input.effort, tier: input.tier, catalog: input.catalog });
    if (!peer.changed) return { critique: input.critique, outcome: { skipped: "no_other_family_offered" } };
    const answer = await input.run(verifierPrompt({ findings: asked, task: input.task, ...(input.workspace ? { workspace: input.workspace } : {}) }), peer.pair);
    const verdicts = parseVerifierAnswer(answer, asked.map((finding) => finding.id));
    const applied = applyVerifier(input.critique, verdicts, `${peer.pair.providerId}/${peer.pair.model}`, findingId);
    return { critique: applied.critique, outcome: applied.verifier };
  } catch (cause) {
    return { critique: input.critique, outcome: { failed: (cause instanceof Error ? cause.message : String(cause)).slice(0, 300) } };
  }
}

/** The check a non-code bench task uses. `artifact` is the default: the result exists and is not empty.
 * A named validator (the employees branch) is a miss until that branch registers it. ponytail: one name; the upgrade is a map of name to function. */
export const DEFAULT_VALIDATOR = "artifact";

export function judgeValidator(validator: string | null | undefined, artifact: string | null | undefined): { ok: boolean; reason: string } {
  const name = validator?.trim() || DEFAULT_VALIDATOR;
  if (name !== DEFAULT_VALIDATOR) return { ok: false, reason: `validator ${name} is not installed yet` };
  if (!artifact || !artifact.trim()) return { ok: false, reason: "artifact missing or empty" };
  return { ok: true, reason: "artifact exists and is not empty" };
}

/** The async registry call: named validators run through validateDeliverable on the artifact's machine. */
export async function runValidator(validator: string | null | undefined, artifact: string | null | undefined, deps: import("../validators").ValidatorDeps & { expectedFindings?: import("./critique-set").ExpectedFinding[] }): Promise<{ ok: boolean; reason: string }> {
  const name = validator?.trim() || DEFAULT_VALIDATOR;
  if (name === "critique_finds") {
    // The critic-eval stratum: the artifact is the critic's parsed findings JSON; ok when every known bug is covered.
    const { judgeCriticFindings } = await import("./critique-set");
    let findings: import("./critique-set").ExpectedFinding[] | { findings?: unknown } = [];
    try { findings = JSON.parse(artifact ?? "[]") as { findings?: unknown }; } catch { return { ok: false, reason: "critic findings unreadable" }; }
    const list = Array.isArray(findings) ? findings : (findings.findings as unknown[]) ?? [];
    const judge = judgeCriticFindings(list as never, deps.expectedFindings ?? []);
    return { ok: judge.found === judge.total, reason: `critic found ${judge.found}/${judge.total} known bugs${judge.missing.length ? `, missed ${judge.missing.slice(0, 2).join(", ")}` : ""}` };
  }
  if (name === DEFAULT_VALIDATOR) return judgeValidator(validator, artifact);
  if (!artifact || !artifact.trim()) return { ok: false, reason: "artifact missing or empty" };
  const { validateDeliverable } = await import("../validators");
  return validateDeliverable(name, artifact, deps);
}

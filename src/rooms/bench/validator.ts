/** The check a non-code bench task uses. `artifact` is the default: the result exists and is not empty.
 * A named validator (the employees branch) is a miss until that branch registers it. ponytail: one name; the upgrade is a map of name to function. */
export const DEFAULT_VALIDATOR = "artifact";

export function judgeValidator(validator: string | null | undefined, artifact: string | null | undefined): { ok: boolean; reason: string } {
  const name = validator?.trim() || DEFAULT_VALIDATOR;
  if (name !== DEFAULT_VALIDATOR) return { ok: false, reason: `validator ${name} is not installed yet` };
  if (!artifact || !artifact.trim()) return { ok: false, reason: "artifact missing or empty" };
  return { ok: true, reason: "artifact exists and is not empty" };
}

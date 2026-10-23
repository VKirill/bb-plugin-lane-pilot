/**
 * External and internal hypotheses checked on the bench (SMA P2-10, Maslov's second level: «ideas from outside → checked on the fixed set»).
 * A hypothesis is the settings that carry an idea. Its two bench arms run the same frozen set with and without them; the comparison's
 * verdict decides: worse → rejected; not worse → the change goes to the night policy as a `setting_change` with the bench proof, and the
 * policy either lets the night apply it at the global level (adopted, undone by writing the old values back) or keeps it off (held).
 */
export type HypothesisState = "proposed" | "benching" | "adopted" | "held" | "rejected";
export const armsOf = (id: string) => ({ base: `hyp-${id}-base`, test: `hyp-${id}` });

/** The seeded hypotheses: SMA P2-11, contracts between roles (RHI): the writer gets only its contract. */
export const SEEDED = [
  { id: "role-contracts", title: "Contracts between roles: a narrow writer brief (contract and plan only) against the full one", source: "RHI arXiv 2607.15524 (SMA P2-11)", settings: { "writer.brief_mode": "narrow" } },
] as const;

export function settingsPair(text: string): [string, unknown] {
  const at = text.indexOf("=");
  if (at <= 0) throw new Error(`--setting wants key=value, got ${text}`);
  const raw = text.slice(at + 1);
  try { return [text.slice(0, at), JSON.parse(raw)]; } catch { return [text.slice(0, at), raw]; }
}

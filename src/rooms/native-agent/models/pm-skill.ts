export const PM_SKILLS_USAGE = "bb lane-pilot pm-skills [--days N] [--json]";

export type PmSkillCount = { skill: string; uses: number; threads: number };

/** The bare name the CLI counts: `bb-global-skills:lane-pilot` and `lane-pilot` are one skill. */
export function pmSkillName(name: string): string {
  const at = name.lastIndexOf(":");
  return (at >= 0 ? name.slice(at + 1) : name).trim();
}

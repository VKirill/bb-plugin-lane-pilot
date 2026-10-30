/**
 * One catalog note for every Lane Pilot agent. The block stays under 600 characters.
 * The PM session is already at its 20000 ceiling, so the PM gets the one line instead.
 */
export const SKILL_CATALOG_BLOCK = `## Skill catalog
Skills are many and filed by section. Run \`bb tools skills-tree --skills --json\`. Start with your sections, then the neighbours. Load only what this task needs (the Skill tool, or read that skill's SKILL.md). If \`progressive_skill_used\` is available, call it for each skill you use. Do not load skills just in case.`;

export const SKILL_CATALOG_LINE = `Skills: \`bb tools skills-tree --skills --json\` — your sections first, then neighbours; load only what this task needs.`;

export const SKILL_CATALOG_LIMIT = 600;

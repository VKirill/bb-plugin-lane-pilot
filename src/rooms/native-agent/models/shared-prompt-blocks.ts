export const BB_LANGUAGE = `## Language
Chat with the human in plain Russian. Every file you write is English.`;

export const BB_DOCS_OWNED = `Read \`docs/\`, \`README.md\`, and \`PROJECT.md\`, do not edit them directly.`;

export function bbDocsRead(audience?: string): string {
  const role = audience ? `, and \`docs/audiences/${audience}.md\` when present` : "";
  return `## Docs\nEntry: \`PROJECT.md\`, \`docs/index.md\`${role}. ${BB_DOCS_OWNED}`;
}

/** Every specialist can set up work the owner wants on a rhythm; `lane_pilot_schedule` is the one bridge tool it gets (overlaySessionTools). */
export const BB_SPECIALIST_SCHEDULE = `## Schedule
Work the owner wants on a rhythm («every Monday collect…») is a scheduled task: \`lane_pilot_schedule\` with \`action: list\` first, then \`create\` (definition: name, task, when). Say in your reply what you scheduled. A thread that a schedule started cannot create schedules: write in your report that a follow-up is needed.`;

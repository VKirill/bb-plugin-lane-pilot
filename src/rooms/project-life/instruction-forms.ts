/**
 * Agent instruction templates (SMA k_d_tpl_instructions): the ready-made forms a project gets for its agent-instruction
 * files. `PROJECT.md` stays the canon every agent reads — the forms are pointers to it, plus a «Developer preferences»
 * section the owner fills once and every instruction file defers to.
 */
export type InstructionProject = { name: string; test?: string; language?: string; style?: string; forbidden?: readonly string[] };
export type InstructionForms = { claudeMd: string; copilotInstructions: string; preferences: string };

const POINTER = ".agents/planning/PROJECT.md is the entry to this project: what it is, how to run and test it, and where the living docs/ map leads. Read it first; this file only tells your tool where the canon is.";

export function instructionForms(project: InstructionProject): InstructionForms {
  const claudeMd = [
    `# ${project.name}`,
    "",
    POINTER,
    "",
    "The «Developer preferences» section of PROJECT.md names the language, the test command, the style and what an agent must not do.",
    "",
  ].join("\n");
  const copilotInstructions = [
    `# ${project.name} — Copilot instructions`,
    "",
    POINTER,
    "",
    "Apply the «Developer preferences» section of PROJECT.md to every suggestion: language, test command, style, forbidden actions.",
    "",
  ].join("\n");
  const preferences = [
    "## Developer preferences",
    "",
    "This section of PROJECT.md is what CLAUDE.md, AGENTS.md and copilot-instructions.md defer to; keep it current and the pointers never go stale.",
    "",
    `- Language: ${project.language ?? "the repository's main language"}`,
    `- Test command: ${project.test ?? "see package scripts"}`,
    `- Style: ${project.style ?? "match the surrounding code"}`,
    `- Forbidden: ${project.forbidden?.length ? project.forbidden.join("; ") : "no force-push, no commits of secrets, no edits outside the task's files"}`,
    "",
  ].join("\n");
  return { claudeMd, copilotInstructions, preferences };
}

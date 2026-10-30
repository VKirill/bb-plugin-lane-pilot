import { choice, choiceOf, defineJudgment } from "../registry";

/**
 * One step of the hierarchical skill pick (B7; the hierarchical_classification cookbook — beam over the catalog tree
 * instead of a flat pass over 200+ skills). The helper `pickSkillTree` calls this judgment level by level: section →
 * subsection → skill, each time a Choice with a `none` option that ends the descent early.
 */
export const SKILL_TREE_PICK_ID = "skills.tree_pick";

export type TreePickInput = { task: string; level: "section" | "subsection" | "skill"; path: string; options: Record<string, string> };
export type TreePickDecision = { picked: string[] };

const NONE = "none";
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export const skillTreePickJudgment = defineJudgment<TreePickInput, TreePickDecision>({
  id: SKILL_TREE_PICK_ID,
  version: 1,
  defaultMode: "shadow",
  timeoutMs: 8_000,
  stateBuilder: (input) => ({
    task: clip(input.task, 1200),
    level: input.level,
    path: clip(input.path, 200),
    options: Object.fromEntries(Object.entries(input.options).slice(0, 24).map(([k, v]) => [clip(k, 60), clip(v, 160)])),
  }),
  questions: (input) => ({
    pick: choice(
      `\`task\` is the work a specialist step asks for. \`options\` is one level of the skill catalog (${input.level}, inside \`path\`). Which option's skills does this task actually need — up to three, or \`${NONE}\` when none fit?`,
      { none: "none of these teach what the task needs", ...input.options },
    ),
  }),
  thresholds: {
    pick_p: { default: 0.3, min: 0.1, max: 0.9, about: "probability an option needs to be taken (top option always taken when >= pick_p)" },
    take_max: { default: 3, min: 1, max: 6, about: "at most this many options above the bar" },
  },
  decide(answers, t) {
    const ranked = choiceOf(answers, "pick")?.ranked ?? [];
    const picked = ranked.filter(([name, p]) => name !== NONE && p >= t.pick_p!).slice(0, t.take_max!).map(([name]) => name);
    return { decision: { picked } };
  },
  fallback: () => ({ picked: [] }),
  describe: (d) => d.picked.join(",") || "none",
});

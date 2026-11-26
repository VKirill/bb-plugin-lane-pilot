import { QUALITY_MODE_SETTING } from "../../contracts";
import { OWNER_WORDS_KEY, secretShaped } from "../../tasks";
import { WRITER_MODEL_KEY, WRITER_PROVIDER_KEY } from "../../writer";

/**
 * Pure first-run onboarding state: four question steps -> draft -> project settings.
 */

/** Four question steps of the first-run interview: what the project is, who writes, how strict, how the owner takes part. */
export const FIRST_RUN_STEPS = [
  { id: "goal", question: "What is this project and what should Lane Pilot do in it first?", setting: null },
  { id: "writer", question: "Which provider and model should write the code (for example codex / gpt-6-luna)?", setting: "writer" },
  { id: "quality", question: "How strict should the checks be: quick, standard or full?", setting: QUALITY_MODE_SETTING },
  { id: "words", question: "Should Lane Pilot wait for your word before every task lands (yes), only before risky work lands (risky), only before money, database changes or a production deploy lands (sensitive, the default) or decide by its gates in code (no)?", setting: OWNER_WORDS_KEY },
] as const;
export type FirstRunStep = (typeof FIRST_RUN_STEPS)[number]["id"];
export type FirstRunDraft = { projectId: string; answers: Partial<Record<FirstRunStep, string>>; at: number; done?: number };

/** Is a first run needed: the project has no writer chosen and the interview was never finished. */
export const firstRunNeeded = (settings: Readonly<Record<string, unknown>>, draft: FirstRunDraft | null) =>
  !draft?.done && !settings[WRITER_PROVIDER_KEY] && !settings["writerProviderId"];

/** An answer into the draft; a secret-shaped one never reaches it (No secret reaches the draft). */
export function answerFirstRun(draft: FirstRunDraft, step: FirstRunStep, answer: string, now = Date.now()): FirstRunDraft {
  if (secretShaped(answer)) throw new Error("this answer looks like a key or a password: it is not kept; save secrets in Env Catalog and answer with their name");
  return { ...draft, answers: { ...draft.answers, [step]: answer.trim().slice(0, 2000) }, at: now };
}

/** The settings the finished interview writes — through the one profile writer, nothing else. */
export function firstRunSettings(draft: FirstRunDraft): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const writer = draft.answers.writer?.split("/").map((part) => part.trim()).filter(Boolean) ?? [];
  if (writer.length === 2) { out[WRITER_PROVIDER_KEY] = writer[0]; out[WRITER_MODEL_KEY] = writer[1]; }
  const quality = draft.answers.quality?.trim().toLowerCase();
  if (quality && ["quick", "standard", "full"].includes(quality)) out.quality_mode = quality;
  const words = draft.answers.words?.trim().toLowerCase();
  if (words) out[OWNER_WORDS_KEY] = /sensitive|деньг|money|миграц|migrat|деплой|deploy|prod|боев/.test(words) ? "sensitive" : /risk|риск|high|высок/.test(words) ? "risky" : /^(yes|да|on)/.test(words) ? "on" : "off";
  return out;
}

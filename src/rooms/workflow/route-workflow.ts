import { scorerOutput, type RouterCard, type RouterModelInput, type RouterModelOutput } from "@lane-pilot/workflow-engine";
import { choice, choiceOf, defineJudgment, noul, noulOf, type Answers } from "@lane-pilot/jev";

/**
 * J-1: which workflow fits the owner's request. One request carries a Choice over the top candidates (plus «none of these»), a
 * Noul «too broad», and, for every candidate input that is a closed set (an enum or a yes/no switch), a Choice or Noul for its
 * value and a Noul «does the request say anything about it» (the function_calling cookbook: ask the branch-specific questions
 * up front, read only the chosen workflow's). Free text and numbers stay in the router's own code.
 *
 * The decision uses probabilities: the top probability, its margin over the runner-up, the probability of «none» and of «too
 * broad». A case that is not clear enough is escalated to the helper thread that decided every route before.
 */
export const NONE = "none_of_these";
export const ROUTE_WORKFLOW_ID = "route.workflow";

export type RouteWorkflowInput = RouterModelInput;
export type RouteWorkflowDecision = RouterModelOutput;

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The card as text for one option: name and description in both languages, a few example requests, what it is not for. */
export function cardText(card: RouterCard): string {
  const examples = [...card.examples.en.slice(0, 2), ...card.examples.ru.slice(0, 2)].map((text) => `"${clip(text, 140)}"`).join("; ");
  return [
    `${card.name.en} / ${card.name.ru}.`,
    clip(card.description.en, 400), clip(card.description.ru, 400),
    examples ? `Example requests: ${examples}.` : "",
    card.not_for.length ? `Not for: ${card.not_for.slice(0, 4).join("; ")}.` : "",
  ].filter(Boolean).join(" ");
}

const humanize = (name: string): string => name.replace(/_/g, " ");

/** The closed-set inputs of a card: an enum (value list) or a boolean switch. */
export const closedInputs = (card: RouterCard) => card.inputs.flatMap((field) => (field.type === "enum" || field.type === "boolean" ? [field] : []));

const inputId = (index: number, name: string): string => `in:${index}:${name}`;

function questions(input: RouteWorkflowInput) {
  const options: Record<string, unknown> = {};
  for (const card of input.candidates) options[card.id] = cardText(card);
  options[NONE] = "No candidate does the job: the request is a small direct edit, a question, or something these workflows do not cover.";
  const out: Record<string, ReturnType<typeof choice> | ReturnType<typeof noul>> = {
    pick: choice(
      "Which workflow should handle the owner's request in `request`? Judge by what the work must produce, not by shared words. The candidates are ordered by a text search that can be wrong. Pick none_of_these when no candidate does the job.",
      options,
    ),
    too_broad: noul(
      "Is the request in `request` too broad or vague to tell what work is wanted: no concrete object, change or result named, so that several different workflows would fit equally?",
      { true: "Almost anything could be meant, for example «do something with the site» or «make it better»", false: "The request names a concrete thing to do or to produce" },
    ),
  };
  input.candidates.forEach((card, index) => {
    for (const field of closedInputs(card)) {
      const what = field.description ? `${humanize(field.name)} (${clip(field.description, 120)})` : humanize(field.name);
      const values = field.values;
      if (field.type === "enum" && values?.length) {
        out[inputId(index, field.name)] = choice(`For the "${card.id}" workflow, which value of ${what} does the owner's request in \`request\` ask for?`, Object.fromEntries(values.map((value) => [value, null])));
        out[`${inputId(index, field.name)}?`] = noul(`Does the request in \`request\` say anything about ${what}, so that the value is stated and not left to the default?`);
      } else if (field.type === "boolean") {
        out[inputId(index, field.name)] = noul(`For the "${card.id}" workflow, does the owner's request in \`request\` ask for ${what} to be on?`);
        out[`${inputId(index, field.name)}?`] = noul(`Does the request in \`request\` say anything about ${what}, so that it is stated and not left to the default?`);
      }
    }
  });
  return out;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** The closed-set inputs the request states, read from the answers about the chosen candidate; anything unsure is left out. */
function statedInputs(answers: Answers, input: RouteWorkflowInput, index: number, minStated: number, minP: number): Record<string, unknown> {
  const card = input.candidates[index];
  const inputs: Record<string, unknown> = {};
  if (!card) return inputs;
  for (const field of closedInputs(card)) {
    const stated = noulOf(answers, `${inputId(index, field.name)}?`);
    if (stated === undefined || stated < minStated) continue;
    if (field.type === "enum") {
      const picked = choiceOf(answers, inputId(index, field.name));
      if (picked && picked.p >= minP && field.values?.includes(picked.top)) inputs[field.name] = picked.top;
    } else {
      const yes = noulOf(answers, inputId(index, field.name));
      if (yes !== undefined && (yes >= minP || yes <= 1 - minP)) inputs[field.name] = yes >= minP;
    }
  }
  return inputs;
}

export const routeWorkflow = defineJudgment<RouteWorkflowInput, RouteWorkflowDecision>({
  id: ROUTE_WORKFLOW_ID,
  version: 1,
  // Active from the start: the live run (66 phrases) is in RESULTS.md, and the PM shows the owner the chosen workflow before anything starts.
  defaultMode: "active",
  timeoutMs: 4_000,
  stateBuilder: (input) => ({ request: clip(input.intent, 3_000), ...(input.context ? { context: clip(input.context, 3_000) } : {}) }),
  questions,
  thresholds: {
    // Never below 0.6: the router treats a confidence under 60 as «ask the owner», and the confidence reported is 100 * p(top).
    min_p: { default: 0.6, min: 0.6, max: 0.95, about: "least probability of the chosen workflow" },
    min_margin: { default: 0.25, min: 0.05, max: 0.9, about: "least lead of the chosen workflow over the runner-up" },
    max_none: { default: 0.3, min: 0.05, max: 0.6, about: "most probability of «none of these» that still allows a workflow" },
    // Measured on 66 phrases: «too broad» wanders between 0.3 and 0.9 for specific requests, and sits at 0.97 or more for «do something with the site».
    max_broad: { default: 0.9, min: 0.5, max: 0.99, about: "most probability of «too broad» that still allows a workflow" },
    broad_clarify: { default: 0.95, min: 0.6, max: 0.99, about: "probability of «too broad» from which the owner is asked, without the helper thread" },
    min_stated: { default: 0.7, min: 0.5, max: 0.95, about: "least probability that the request states a closed-set input before it is filled" },
    min_input_p: { default: 0.6, min: 0.4, max: 0.95, about: "least probability of the value of a closed-set input before it is filled" },
  },
  decide(answers, t, input) {
    const pick = choiceOf(answers, "pick"), broad = noulOf(answers, "too_broad");
    if (!pick || broad === undefined) return { escalate: "model-thread" };
    const none = answers.pick?.type === "choice" ? answers.pick.probabilities[NONE] ?? 0 : 0;
    const rejected = (except: string | null) => pick.ranked.filter(([id]) => id !== except && id !== NONE).map(([id, p]) => ({ id, reason: `Jev probability ${round2(p)}` }));
    if (broad >= t.broad_clarify!) {
      return { decision: { choice: null, confidence: 0, pattern: `jev: the request is too broad (p ${round2(broad)})`, rejected: rejected(null), questions: [] } };
    }
    if (pick.top === NONE) {
      if (pick.p >= t.min_p! && pick.margin >= t.min_margin! && broad < t.max_broad!) {
        return { decision: { choice: null, confidence: Math.round(100 * pick.p), pattern: `jev: no candidate fits (p ${round2(pick.p)})`, rejected: rejected(null), questions: [] } };
      }
      return { escalate: "model-thread" };
    }
    if (pick.p >= t.min_p! && pick.margin >= t.min_margin! && none < t.max_none! && broad < t.max_broad!) {
      const index = input.candidates.findIndex((card) => card.id === pick.top);
      const inputs = statedInputs(answers, input, index, t.min_stated!, t.min_input_p!);
      return { decision: {
        choice: pick.top, confidence: Math.round(100 * pick.p),
        pattern: `jev: ${pick.top} (p ${round2(pick.p)}, lead ${round2(pick.margin)}${pick.second ? ` over ${pick.second}` : ""}, none ${round2(none)}, too broad ${round2(broad)})`,
        rejected: rejected(pick.top), questions: [], ...(Object.keys(inputs).length ? { inputs } : {}),
      } };
    }
    return { escalate: "model-thread" };
  },
  fallback: (input) => scorerOutput(input.candidates),
  describe: (decision) => (decision.choice ? `${decision.choice} (${decision.confidence})` : "none"),
});

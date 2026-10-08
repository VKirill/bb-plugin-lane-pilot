import { choice, choiceOf, defineJudgment, noul, noulOf } from "../jev/registry";
import type { Kind } from "./model";

/**
 * What a fragment of the owner's own message says about the owner. Jev (TypeSafe) is the only outside judge here: the spec allows
 * no second opinion from another vendor for this step. The text sent is the masked fragment only, never the thread around it, and
 * it is sent only when the owner starts a classifying load.
 *
 * Three questions in one request: the kind of fact (or `nothing`), whether the fragment is about the owner at all rather than a
 * task for an assistant, and whether it touches health, family, money, documents or clients. `decide` takes a kind only when it
 * is clear; anything else is `nothing`, which stores nothing. Receipts keep the hash and size of the text, never the text.
 */
export const FRAGMENT_JUDGMENT_ID = "anamnesis.fragment";
export const FRAGMENT_KINDS: readonly Kind[] = ["skill", "project", "event", "person", "interest", "preference", "fact", "tool"];
export type FragmentInput = { text: string };
export type FragmentDecision = { kind: Kind | "nothing"; kindP: number; aboutOwner: number; sensitive: number };

export const fragmentJudgment = defineJudgment<FragmentInput, FragmentDecision>({
  id: FRAGMENT_JUDGMENT_ID,
  version: 1,
  // Used only from an explicit command of the owner, so it is active; the command is the consent.
  defaultMode: "active",
  timeoutMs: 6_000,
  stateBuilder: (input) => ({ fragment: input.text }),
  questions: () => ({
    kind: choice(
      "`fragment` is a message the person wrote to their assistants. Does it state something lasting about the person who wrote it, and what kind? Choose `nothing` when it only asks for something to be done, asks a question, reacts to the current work or states a one-off detail of the task.",
      {
        skill: "Something the person can do or knows: a tool, language, method or area of expertise they use or are learning.",
        project: "A project, product or business of the person, and their role or progress in it.",
        event: "Something that happened on a date and is worth remembering: a launch, a decision, a trip, a milestone.",
        person: "A person around the writer (colleague, client, relative, friend, contractor) and who they are to the writer.",
        interest: "A topic the person is drawn to beyond a single task.",
        preference: "How the person likes things done, communicated or decided; a standing rule they want followed.",
        fact: "A stable fact about the person: where they live, their role, languages, setup, circumstances.",
        tool: "A service, device, machine or account the person uses as part of their setup.",
        nothing: "A request, question, status check, reaction or detail that is only about the current task.",
      },
    ),
    about_owner: noul(
      "Is `fragment` about the person who wrote it (who they are, what they do or know, their projects, people, interests or ways of working), as opposed to only instructing an assistant about a task?",
      { true: "«I run a small agency», «I always want reports in Russian», «my daughter starts school», «I'm learning Blender»", false: "«fix the failing test», «why is the build red», «run it again», «ok, merge it»" },
    ),
    sensitive: noul(
      "Does `fragment` touch health, family or relationships, money or taxes, identity documents, or the writer's clients and their business?",
      { true: "Illness, a relative, a loan, a passport number, what a named client pays", false: "Tools, code, project names, working preferences, public information" },
    ),
  }),
  thresholds: {
    min_kind_p: { default: 0.45, min: 0.3, max: 0.95, about: "least probability of the chosen kind" },
    min_margin: { default: 0.1, min: 0.0, max: 0.8, about: "least lead of the chosen kind over the runner-up" },
    min_about: { default: 0.5, min: 0.3, max: 0.95, about: "least probability that the fragment is about the owner" },
  },
  decide(answers, t) {
    const pick = choiceOf(answers, "kind"), about = noulOf(answers, "about_owner") ?? 0, sensitive = noulOf(answers, "sensitive") ?? 0;
    if (!pick || pick.top === "nothing" || pick.p < t.min_kind_p! || pick.margin < t.min_margin! || about < t.min_about!) {
      return { decision: { kind: "nothing", kindP: pick?.p ?? 0, aboutOwner: about, sensitive } };
    }
    const kind = (FRAGMENT_KINDS as readonly string[]).includes(pick.top) ? pick.top as Kind : "nothing";
    return { decision: { kind, kindP: pick.p, aboutOwner: about, sensitive } };
  },
  fallback: () => ({ kind: "nothing", kindP: 0, aboutOwner: 0, sensitive: 0 }),
  describe: (decision) => decision.kind,
});

/** The sensitivity a decision gives a stored fragment: never `public`, and `sensitive` from a moderate probability on. */
export const SENSITIVE_FROM = 0.4;

import { choice, choiceOf, defineJudgment, noul, noulOf } from "@lane-pilot/jev";
import type { Kind } from "./model";

/**
 * What a fragment of the owner's own message says about the owner. Jev (TypeSafe) is the only outside judge here: the spec allows
 * no second opinion from another vendor for this step. The text sent is the masked fragment only, never the thread around it, and
 * it is sent only when the owner starts a classifying load.
 *
 * Three questions in one request: the kind of fact (or `nothing`), whether the fragment is about the owner at all rather than a
 * task for an assistant, and whether it touches health, family, money, documents or clients. `decide` takes a kind only when it
 * is clear; anything else is `nothing`, which stores nothing. Family and health fragments are judged too (personal data masked
 * first); they are stored as sensitive records. Receipts keep the hash and size of the text, never the text.
 */
export const FRAGMENT_JUDGMENT_ID = "anamnesis.fragment";
/** What the portrait of the owner holds: who he is, what he knows and can do, the people close to him, hobbies, interests, life events, preferences. Projects and tools are work, not the person. */
export const FRAGMENT_KINDS: readonly Kind[] = ["self", "knowledge", "skill", "person", "hobby", "interest", "event", "preference", "fact"];
export type FragmentInput = { text: string };
export type FragmentDecision = { kind: Kind | "nothing"; kindP: number; aboutOwner: number; sensitive: number };

export const fragmentJudgment = defineJudgment<FragmentInput, FragmentDecision>({
  id: FRAGMENT_JUDGMENT_ID,
  version: 2,
  // Used only from an explicit command of the owner, so it is active; the command is the consent.
  defaultMode: "active",
  timeoutMs: 6_000,
  stateBuilder: (input) => ({ fragment: input.text }),
  questions: () => ({
    kind: choice(
      "`fragment` is a message the person wrote to their assistants. Does it state something lasting about the person who wrote it as a human being, and what kind? Choose `nothing` when it only asks for something to be done, asks a question, reacts to the current work, describes a server, a key, an address or other technical setup, or states a one-off detail of the task.",
      {
        self: "Who the person is: character, values, beliefs, how they think, work and make decisions, what matters to them.",
        knowledge: "Something the person knows or has studied: a subject area, a body of knowledge, education.",
        skill: "Something the person can do: a craft, a language, a method or a tool they use well or are learning.",
        person: "A person close to the writer (spouse, child, parent, relative, friend, colleague) and who they are to the writer.",
        hobby: "An activity the person does for pleasure in their free time.",
        interest: "A topic the person is drawn to, reads about or follows beyond a single task.",
        event: "Something that happened to the person on a date and is worth remembering: a move, a trip, a birth, a launch, a decision, a milestone.",
        preference: "How the person likes things done, communicated or decided; a standing rule they want followed.",
        fact: "A stable biographical fact about the person: where they live, their role, languages, family situation, health circumstances.",
        nothing: "A request, question, status check, reaction, technical detail or anything that is only about the current task.",
      },
    ),
    about_owner: noul(
      "Is `fragment` about the person who wrote it as a human being (who they are, what they know or can do, their family and close people, hobbies, interests, ways of living and working), as opposed to only instructing an assistant about a task?",
      { true: "«I run a small agency», «my daughter starts school», «I'm learning Blender», «I like cycling», «I always want reports in Russian»", false: "«fix the failing test», «why is the build red», «ssh to the server and restart it», «ok, merge it»" },
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

/**
 * Whether a new fragment restates a record the owner already has, or contradicts it (A4). One known record at a time, the nearest by
 * words (chosen in code, so Jev is not asked about a fragment with nothing close). Both texts are masked before they are sent. `new` is
 * also what a failed or unclear answer means: the fragment is stored as its own candidate, never merged on a guess.
 */
export const MATCH_JUDGMENT_ID = "anamnesis.match";
export type MatchInput = { fragment: string; known: string };
export type MatchDecision = { relation: "same" | "contradicts" | "new"; same: number; contradicts: number };

export const matchJudgment = defineJudgment<MatchInput, MatchDecision>({
  id: MATCH_JUDGMENT_ID,
  version: 1,
  defaultMode: "active",
  timeoutMs: 6_000,
  stateBuilder: (input) => ({ fragment: input.fragment, known: input.known }),
  questions: () => ({
    same: noul(
      "Does `fragment` state the same thing about the writer as `known` (the same fact, preference or project, only worded differently or repeated)?",
      { true: "known: «I live in Madrid», fragment: «we moved to Madrid two years ago, I like it here»", false: "known: «I live in Madrid», fragment: «I am looking for a flat in Valencia»" },
    ),
    contradicts: noul(
      "Does `fragment` say something that cannot be true together with `known`, or replace it with a newer value (a changed city, role, rule, status)?",
      { true: "known: «reports in English», fragment: «from now on all reports in Russian»", false: "known: «reports in English», fragment: «reports should be short»" },
    ),
  }),
  thresholds: {
    min_same: { default: 0.65, min: 0.4, max: 0.95, about: "least probability that the fragment restates the known record" },
    min_contradicts: { default: 0.65, min: 0.4, max: 0.95, about: "least probability that the fragment contradicts the known record" },
  },
  decide(answers, t) {
    const same = noulOf(answers, "same") ?? 0, contradicts = noulOf(answers, "contradicts") ?? 0;
    // A contradiction is shown to the owner, so it wins over a restatement; a clear restatement is merged; anything else is new.
    if (contradicts >= t.min_contradicts!) return { decision: { relation: "contradicts", same, contradicts } };
    if (same >= t.min_same!) return { decision: { relation: "same", same, contradicts } };
    return { decision: { relation: "new", same, contradicts } };
  },
  fallback: () => ({ relation: "new", same: 0, contradicts: 0 }),
  describe: (decision) => decision.relation,
});

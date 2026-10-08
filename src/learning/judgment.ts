import { choice, choiceOf, defineJudgment, noul, noulOf, score, type Answers } from "../jev/registry";

/**
 * What an owner's message is, for the part of Lane Pilot that learns from them (T1). One Jev request asks four things about the
 * message and the agent's reply before it: its kind, whether it is worth remembering, how far it reaches, how annoyed the owner is,
 * and whether it names a date or a promise. Measured on 171 real messages (2026-10-08): Jev sees the corrections that another
 * classifier files under «task», and a message with a lasting correction is the one that teaches.
 *
 * The decision is a route, never a verdict on the owner: `learn` (a model reads it next), `none` (nothing to learn) or `contested`
 * (a second opinion decides). The same rule (`routeOf`) turns the second opinion's answers into a route, so the two are comparable.
 */
export const OWNER_MESSAGE_JUDGMENT_ID = "learning.owner_message";

/** What the message is for. `other` is the unclear remainder. */
export const MESSAGE_KINDS = {
  task: "asks for new work to be done",
  correction: "says the agent did something wrong or not as wanted, and how it should be",
  rule: "states a lasting rule or preference for how the agent should work, write or decide from now on",
  decision: "chooses between options, approves or rejects a proposal, settles a question for the project",
  fact: "tells a fact about the owner, the projects, people, machines or accounts",
  deadline: "names a date, a deadline, a reminder or something to do later",
  question: "asks for information or an opinion",
  other: "none of these",
} as const;
export type MessageKind = keyof typeof MESSAGE_KINDS;
export const MESSAGE_KIND_NAMES = Object.keys(MESSAGE_KINDS) as MessageKind[];
/** The kinds a model may draw a rule, decision, preference or reminder from. */
export const LEARN_KINDS: readonly MessageKind[] = ["correction", "rule", "decision", "fact", "deadline"];

export const SCOPES = {
  task: "only the current task",
  project: "this project or component",
  owner: "all projects and agents of the owner",
} as const;
export type Scope = keyof typeof SCOPES;

export type Route = "none" | "contested" | "learn";
export type MessageSignals = { kind: MessageKind; kindP: number; learnP: number; durable: number; scope: Scope; scopeP: number; deadline: number; frustration: number; mild: number };
export type MessageDecision = MessageSignals & { route: Route };
export type MessageInput = { text: string; prev?: string | undefined };

export const ROUTE_LOW = 0.35, ROUTE_HIGH = 0.6, ANGRY_P = 0.5;
export type RouteThresholds = { route_low: number; route_high: number };

/**
 * The route of a message from its signals: `learn` when a learning kind or a date is likely enough, `none` when neither that nor a
 * lasting-worth guess is, `contested` between. «Worth remembering» alone never makes `learn`: Jev says yes to half of all messages.
 */
export function routeOf(signals: Pick<MessageSignals, "learnP" | "deadline" | "durable">, t: RouteThresholds = { route_low: ROUTE_LOW, route_high: ROUTE_HIGH }): Route {
  const strength = Math.max(signals.learnP, signals.deadline);
  if (strength >= t.route_high) return "learn";
  if (strength < t.route_low && signals.durable < t.route_high) return "none";
  return "contested";
}

/** Probabilities of the kinds as a plain map, and the sum over the learning kinds. */
export function learnShare(probabilities: Record<string, number>): number {
  return Math.min(1, LEARN_KINDS.reduce((sum, kind) => sum + (probabilities[kind] ?? 0), 0));
}

const rounded = (value: number) => Math.round(value * 1000) / 1000;

export function signalsFromAnswers(answers: Answers): MessageSignals | null {
  const kind = choiceOf(answers, "kind"), scope = choiceOf(answers, "scope");
  if (!kind) return null;
  const level = answers.frustration;
  const levels = level?.type === "score" ? level.probabilities : {};
  return {
    kind: (kind.top in MESSAGE_KINDS ? kind.top : "other") as MessageKind, kindP: rounded(kind.p),
    learnP: rounded(learnShare(Object.fromEntries(kind.ranked))), durable: rounded(noulOf(answers, "durable") ?? 0),
    scope: (scope && scope.top in SCOPES ? scope.top : "task") as Scope, scopeP: rounded(scope?.p ?? 0),
    deadline: rounded(noulOf(answers, "deadline") ?? 0),
    frustration: rounded(levels["2"] ?? 0), mild: rounded((levels["1"] ?? 0) + (levels["2"] ?? 0)),
  };
}

export const ownerMessageJudgment = defineJudgment<MessageInput, MessageDecision | null>({
  id: OWNER_MESSAGE_JUDGMENT_ID,
  version: 1,
  // Whether anything is done with the answer is the room's own mode (observe or active); the judgment itself always asks.
  defaultMode: "active",
  timeoutMs: 8_000,
  stateBuilder: (input) => ({ owner_message: input.text, previous_agent_reply: input.prev ?? "" }),
  questions: () => ({
    kind: choice(
      "What is the main purpose of `owner_message`, the owner writing to an AI agent in a work chat? `previous_agent_reply` is the agent's message just before it, if any; use it to see what a short message refers to.",
      MESSAGE_KINDS,
    ),
    durable: noul("Does `owner_message` contain something an AI assistant should remember for FUTURE sessions (a lasting preference, rule, correction pattern, decision or fact), not only for the current task?"),
    scope: choice("If something in `owner_message` should be remembered, how widely does it apply?", SCOPES),
    frustration: score("How frustrated or dissatisfied with the agent is the owner in `owner_message`?", ["calm", "mildly dissatisfied", "clearly frustrated"]),
    deadline: noul(
      "Does `owner_message` name a date, a deadline, a reminder or something the agent promised or must do later?",
      { true: "«remind me on Friday», «by the 20th», «next week let's…»", false: "an instruction to act now, a question, a reaction" },
    ),
  }),
  thresholds: {
    route_low: { default: ROUTE_LOW, min: 0.1, max: 0.6, about: "below this and not worth remembering: nothing to learn" },
    route_high: { default: ROUTE_HIGH, min: 0.4, max: 0.95, about: "at or above this a model reads the message; between the two a second opinion decides" },
  },
  decide(answers, t) {
    const signals = signalsFromAnswers(answers);
    if (!signals) return { decision: null };
    return { decision: { ...signals, route: routeOf(signals, { route_low: t.route_low!, route_high: t.route_high! }) } };
  },
  // Jev cannot be asked: the caller goes to the second opinion; the message is not guessed at.
  fallback: () => null,
  describe: (decision) => (decision ? `${decision.route}:${decision.kind}` : "unclear"),
});

/** Lasting-rule routes need a number the room can compare: how likely it is that the message teaches anything. */
export const teachesP = (signals: Pick<MessageSignals, "learnP" | "deadline">): number => Math.max(signals.learnP, signals.deadline);

/**
 * Is a new statement the same as, the opposite of, or different from each statement already in force (T3, deduplication)? One
 * Choice per existing statement in one request. «Opposite» means a rule that cannot hold together with the new one.
 */
export const SAME_AS_JUDGMENT_ID = "learning.same_as";
export type Relation = "same" | "opposite" | "different";
export type SameAsInput = { statement: string; existing: string[] };
export type SameAsDecision = Array<{ relation: Relation; p: number }>;

export const sameAsJudgment = defineJudgment<SameAsInput, SameAsDecision>({
  id: SAME_AS_JUDGMENT_ID,
  version: 1,
  defaultMode: "active",
  timeoutMs: 8_000,
  stateBuilder: (input) => ({ new_statement: input.statement }),
  questions: (input) => Object.fromEntries(input.existing.slice(0, 40).map((text, index) => [`r${index + 1}`, choice(
    "Compare `new_statement` with the existing statement given here. Do they say the same thing, say opposite things that cannot both hold, or are they about different things?",
    {
      same: `the same instruction or fact, possibly in other words. Existing statement: ${text.slice(0, 500)}`,
      opposite: `they contradict: following one means not following the other. Existing statement: ${text.slice(0, 500)}`,
      different: "different subjects, or compatible",
    },
  )])),
  thresholds: { min_p: { default: 0.6, min: 0.4, max: 0.95, about: "least probability of «same» or «opposite» to act on it" } },
  decide(answers, t, input) {
    return { decision: input.existing.slice(0, 40).map((_, index) => {
      const pick = choiceOf(answers, `r${index + 1}`);
      if (!pick || (pick.top !== "same" && pick.top !== "opposite") || pick.p < t.min_p!) return { relation: "different" as const, p: pick?.p ?? 0 };
      return { relation: pick.top as Relation, p: rounded(pick.p) };
    }) };
  },
  fallback: (input) => input.existing.slice(0, 40).map(() => ({ relation: "different" as const, p: 0 })),
  describe: (decision) => decision.filter((row) => row.relation !== "different").map((row) => row.relation).join(",") || "different",
});


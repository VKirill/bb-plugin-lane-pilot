import type { CouncilMessage, CouncilSeat, CouncilSession } from "./contract";

const RULES = [
  "Ground every claim in the evidence pack or in the other seats' statements; mark guesses as guesses.",
  "Write in the language of the question. Be concrete: name screens, requests, numbers, phrases.",
  "Keep it under 400 words. No preamble, no summary of what others said unless you disagree.",
].join("\n");

/** Seats and the chair run inside the project checkout with tools; this is what they may and may not do there. */
export function workspaceRules(workspace: string | undefined, lens?: string): string {
  if (!workspace) return "";
  return [
    "## Your workspace",
    `You are running inside the project checkout at ${workspace} with file and shell tools. Read files, grep, list directories and run read-only commands (tests, type checks, git log/diff) to verify every claim before you make it. Cite what you read as path:line.`,
    lens ? `Look first at: ${lens}` : "",
    "Do not modify, create or delete files, do not commit, install packages, start servers or call external services. The council decides; writers implement.",
  ].filter(Boolean).join("\n");
}

function feedText(messages: readonly CouncilMessage[], seats: readonly CouncilSeat[]): string {
  if (!messages.length) return "(nothing yet)";
  const name = (seatId: string) => seats.find((seat) => seat.id === seatId)?.title ?? seatId;
  return messages.map((message) => `### ${name(message.seatId)} (round ${message.round}, ${message.kind})\n${message.text}`).join("\n\n");
}

export function agendaPrompt(input: { session: CouncilSession; evidence: string; workspace?: string }): string {
  return [
    "You chair a council of directors that has to answer one question about a product.",
    `Question: ${input.session.question}`,
    "Turn it into an agenda of 3 to 5 sharp sub-questions the seats must answer, and 3 to 5 decision criteria the chair will rank proposals by (for example expected effect on sales, simplicity for the user, effort, confidence).",
    "Answer with one JSON object only: {\"agenda\":[\"...\"],\"criteria\":[\"...\"]}",
    workspaceRules(input.workspace, "the README, PROJECT.md and the main user flows, enough to ask sharp questions"),
    "## Evidence pack",
    input.evidence,
  ].filter(Boolean).join("\n\n");
}

export function seatPrompt(input: { session: CouncilSession; seat: CouncilSeat; round: number; evidence: string; feed: readonly CouncilMessage[]; sinceSeq: number; workspace?: string }): string {
  const delta = input.feed.filter((message) => message.seq > input.sinceSeq);
  const head = input.round === 1
    ? "Give your position on every agenda item from your role's point of view. End with your top three proposals, each with the expected effect and the effort."
    : "Read what the others said since your last turn. Reply only where you disagree, can add evidence, or change your mind. If you have nothing to add, answer exactly: PASS";
  return [
    `You are the ${input.seat.title} at a council of directors. ${input.seat.instruction}`,
    `Question: ${input.session.question}`,
    `Agenda:\n${input.session.agenda.map((item, index) => `${index + 1}. ${item}`).join("\n")}`,
    `Decision criteria: ${input.session.criteria.join("; ")}`,
    head,
    RULES,
    workspaceRules(input.workspace, input.seat.lens),
    "## Evidence pack",
    input.evidence,
    `## What was said since your last turn`,
    feedText(delta, input.session.seats),
  ].filter(Boolean).join("\n\n");
}

export function chairPrompt(input: { session: CouncilSession; evidence: string; feed: readonly CouncilMessage[]; workspace?: string }): string {
  return [
    "You chair the council. The discussion is over; write the decision record.",
    `Question: ${input.session.question}`,
    `Decision criteria: ${input.session.criteria.join("; ")}`,
    "Rank the proposals by the criteria. Keep every dissent that was not resolved, name the seat. Every next task must have an objective and acceptance a writer can verify.",
    workspaceRules(input.workspace, "whatever the seats disagreed about; verify the disputed facts yourself before ranking"),
    "Answer with one JSON object only, matching exactly: {\"summary\":\"...\",\"options\":[{\"title\":\"...\",\"expectedImpact\":\"...\",\"effort\":\"low|medium|high\",\"confidence\":\"low|medium|high\",\"evidence\":[\"...\"]}],\"recommendation\":\"...\",\"dissent\":[{\"seat\":\"...\",\"point\":\"...\"}],\"experiments\":[{\"hypothesis\":\"...\",\"metric\":\"...\"}],\"nextTasks\":[{\"title\":\"...\",\"objective\":\"...\",\"acceptance\":[\"...\"],\"toAgent\":\"copy-lead|seo-specialist|design-lead|writer\"}]}",
    "## Evidence pack",
    input.evidence,
    "## The discussion",
    feedText(input.feed, input.session.seats),
  ].filter(Boolean).join("\n\n");
}

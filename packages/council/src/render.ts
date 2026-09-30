import type { CouncilMessage, CouncilSession, DecisionRecord } from "./contract";

export function slugify(text: string, max = 48): string {
  const ascii = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  return (ascii || "council").slice(0, max).replace(/-+$/g, "");
}

export function decisionFileName(session: CouncilSession, date = new Date(session.createdAt)): string {
  return `docs/decisions/${date.toISOString().slice(0, 10)}-council-${slugify(session.question)}.md`;
}

/** The decision page: question, agenda, options ranked, recommendation, dissent, experiments, next tasks, and the seats. */
export function decisionMarkdown(session: CouncilSession, decision: DecisionRecord, feed: readonly CouncilMessage[]): string {
  const seatTitle = (id: string) => session.seats.find((seat) => seat.id === id)?.title ?? id;
  const seats = session.seats.map((seat) => `- ${seat.title}${seat.providerId && seat.model ? ` (${seat.providerId}/${seat.model})` : ""}`).join("\n");
  const options = decision.options.map((option, index) => [
    `### ${index + 1}. ${option.title}`,
    `Expected impact: ${option.expectedImpact}`,
    `Effort: ${option.effort}. Confidence: ${option.confidence}.`,
    ...(option.evidence.length ? [`Evidence:\n${option.evidence.map((item) => `- ${item}`).join("\n")}`] : []),
  ].join("\n\n")).join("\n\n");
  const rounds = Math.max(0, ...feed.map((message) => message.round));
  return [
    "---",
    `title: ${JSON.stringify(`Council: ${session.question}`)}`,
    `date: ${new Date(session.createdAt).toISOString().slice(0, 10)}`,
    `council: ${session.id}`,
    "status: decided",
    "---",
    "",
    `# ${session.question}`,
    "",
    decision.summary,
    "",
    "## Agenda",
    session.agenda.map((item, index) => `${index + 1}. ${item}`).join("\n"),
    "",
    `Decision criteria: ${session.criteria.join("; ")}.`,
    "",
    "## Options",
    options,
    "",
    "## Recommendation",
    decision.recommendation,
    "",
    "## Dissent",
    decision.dissent.length ? decision.dissent.map((item) => `- **${item.seat}**: ${item.point}`).join("\n") : "None recorded.",
    "",
    "## Experiments",
    decision.experiments.length ? decision.experiments.map((item) => `- ${item.hypothesis} Measure: ${item.metric}`).join("\n") : "None proposed.",
    "",
    "## Next tasks",
    decision.nextTasks.length ? decision.nextTasks.map((task) => `- **${task.title}**${task.toAgent ? ` → ${task.toAgent}` : ""}: ${task.objective}\n  Acceptance: ${task.acceptance.join("; ")}`).join("\n") : "None.",
    "",
    "## Seats",
    seats,
    "",
    `Rounds held: ${rounds}. Statements: ${feed.filter((message) => message.kind === "position" || message.kind === "reply").length}.`,
    "",
    "<details><summary>Transcript</summary>",
    "",
    feed.filter((message) => message.kind !== "status").map((message) => `**${seatTitle(message.seatId)}** (round ${message.round})\n\n${message.text}`).join("\n\n---\n\n"),
    "",
    "</details>",
    "",
  ].join("\n");
}

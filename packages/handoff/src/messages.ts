import type { HandoffCard } from "./contract";

function budgetLine(card: HandoffCard): string {
  const parts: string[] = [];
  if (card.budget.maxMinutes) parts.push(`${card.budget.maxMinutes} min`);
  if (card.budget.maxTurns) parts.push(`${card.budget.maxTurns} turns`);
  if (card.budget.maxTokens) parts.push(`${card.budget.maxTokens} tokens`);
  if (card.deadlineAt) parts.push(`deadline ${new Date(card.deadlineAt).toISOString()}`);
  return parts.length ? parts.join(", ") : "none stated";
}

/** The message the recipient's thread receives. It ends with the exact receipt shape to answer with. */
export function handoffMessage(card: HandoffCard): string {
  const inputs = card.inputs.length
    ? card.inputs.map((input) => `- ${input.kind}: ${input.ref}${input.note ? ` (${input.note})` : ""}`).join("\n")
    : "- none";
  return [
    `Handoff ${card.id} from ${card.fromAgent}: ${card.title}`,
    "",
    "## Objective",
    card.objective,
    "",
    "## Acceptance",
    card.acceptance.map((line, index) => `${index + 1}. ${line}`).join("\n"),
    "",
    "## Inputs",
    inputs,
    "",
    `## Budget\n${budgetLine(card)}`,
    "",
    "## How to answer",
    "Do the work, then finish your turn with one fenced JSON block and nothing after it:",
    "```json",
    `{"handoff":"${card.id}","status":"done|blocked|rejected","summary":"what was done or why not","outputs":["paths or links produced"],"evidence":["how each acceptance line was checked"]}`,
    "```",
    "Use `blocked` when you cannot proceed without something from the sender, `rejected` when the task is not yours or not feasible.",
  ].join("\n");
}

/** Finds the receipt block for a card in a recipient's final message, if the message follows the format. */
export function extractHandoffReceiptBlock(output: string, handoffId: string): string | null {
  const blocks = [...output.matchAll(/```json\s*([\s\S]*?)```/gi)].map((match) => match[1]?.trim() ?? "");
  for (const block of blocks.reverse()) {
    try {
      const parsed = JSON.parse(block) as { handoff?: unknown };
      if (parsed && typeof parsed === "object" && parsed.handoff === handoffId) {
        const { handoff: _handoff, ...receipt } = parsed;
        return JSON.stringify(receipt);
      }
    } catch {
      continue;
    }
  }
  return null;
}

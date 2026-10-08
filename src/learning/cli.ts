import { OPS, type Learning, type LearningOp } from "./service";

/** `bb lane-pilot learning <op> …`: the same operations as the PM's action `lane_pilot_memory {action:"learned"}`, for the owner at a terminal. */
export const LEARNING_USAGE = [
  "bb lane-pilot learning status",
  "bb lane-pilot learning review [n]                 cases to check by hand",
  "bb lane-pilot learning label <id> ok|wrong",
  "bb lane-pilot learning items [state] [projectId]",
  "bb lane-pilot learning accept|reject|drop <id>",
  "bb lane-pilot learning digest [--send]            the day's report; without --send only composed",
  "bb lane-pilot learning rules <projectId> [text…]  the PM rules (those that apply to the text)",
  "bb lane-pilot learning agreement [days]",
  "bb lane-pilot learning signals [kind]",
  "bb lane-pilot learning config [key=value …]       mode=observe|active, sample, dailyJudgeCap, secondOpinion, …",
  "bb lane-pilot learning extract <projectId>",
].join("\n");

export async function runLearningCli(learning: Learning, argv: string[]): Promise<{ exitCode: number; stdout?: string; stderr?: string }> {
  const [op, ...args] = argv;
  if (!op || op === "help" || !(OPS as readonly string[]).includes(op)) return { exitCode: op && op !== "help" ? 1 : 0, ...(op && op !== "help" ? { stderr: `unknown operation «${op}»\n${LEARNING_USAGE}` } : { stdout: LEARNING_USAGE }) };
  try {
    const send = args.includes("--send");
    const words = args.filter((word) => word !== "--send");
    const result = await learning.run(op as LearningOp, ((): Parameters<Learning["run"]>[1] => {
      switch (op) {
        case "review": return { limit: words[0] ? Number(words[0]) : undefined };
        case "label": return { id: words[0], correct: words[1] === "ok" ? true : words[1] === "wrong" ? false : undefined };
        case "items": return { state: words[0], projectId: words[1] };
        case "accept": case "reject": case "drop": return { id: words[0] };
        case "digest": return { send };
        case "rules": return { projectId: words[0], text: words.slice(1).join(" ") || undefined };
        case "agreement": return { days: words[0] ? Number(words[0]) : undefined };
        case "signals": return { kind: words[0] };
        case "config": return { settings: words };
        case "extract": return { projectId: words[0] };
        default: return {};
      }
    })());
    return { exitCode: 0, stdout: JSON.stringify(result, null, 2) };
  } catch (cause) {
    return { exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause) };
  }
}

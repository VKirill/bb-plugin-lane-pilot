import { RETURN_STAGES, type ReturnStage } from "@lane-pilot/contracts";
import type { StageReturnApi } from "./stage-return";

export const RETURN_USAGE = [
  "bb lane-pilot return <task-id> --to discussion|planning|writer --note \"…\"   (send a task back to an earlier stage with added context: the note is recorded, the receipts of that stage and every later one are reset, a running attempt is stopped with the exit confirmed and its work on record, and the work restarts from the stage with the note in its input — the PM gets the note for discussion and planning, the writer for writer)",
  "bb lane-pilot returns <task-id>   (the returns on record for a task: who, to which stage, the note, what was stale and kept, how far each got)",
].join("\n");

type Result = { exitCode: number; stdout?: string; stderr?: string };

/** `--to X` and `--note words…` (the note runs to the next flag, so it needs no quoting) out of the words; the rest are the task. */
function parse(argv: string[]): { words: string[]; to?: string; note?: string; by?: string } {
  const words: string[] = [];
  const out: { to?: string; note?: string; by?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index]!;
    if (word === "--to" || word === "--by") { out[word === "--to" ? "to" : "by"] = argv[index + 1]; index += 1; continue; }
    if (word === "--note") {
      const parts: string[] = [];
      while (index + 1 < argv.length && !argv[index + 1]!.startsWith("--")) { parts.push(argv[index + 1]!); index += 1; }
      out.note = parts.join(" ");
      continue;
    }
    words.push(word);
  }
  return { words, ...out };
}

export async function runReturnCli(api: StageReturnApi, command: "return" | "returns", argv: string[]): Promise<Result> {
  try {
    const { words, to, note, by } = parse(argv);
    if (command === "returns") {
      if (words.length !== 1) throw new Error(`usage:\n${RETURN_USAGE}`);
      return { exitCode: 0, stdout: JSON.stringify(api.status(words[0]!), null, 2) };
    }
    if (words.length !== 1 || !to || !(RETURN_STAGES as readonly string[]).includes(to)) throw new Error(`usage:\n${RETURN_USAGE}`);
    const result = await api.returnTask({ ref: words[0]!, to: to as ReturnStage, note: note ?? "", ...(by ? { by } : {}) });
    return { exitCode: result.ok ? 0 : 1, stdout: JSON.stringify(result, null, 2) };
  } catch (cause) {
    return { exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause) };
  }
}

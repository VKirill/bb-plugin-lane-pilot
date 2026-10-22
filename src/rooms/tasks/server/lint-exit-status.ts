/**
 * Two ways a verification command passes whatever the writer did, both from rules the PM had to write down because the contract lint
 * did not stop them (SMA block 6, P2-6: a rule that stays text is broken again; this is the check that replaces the text):
 *   - a pipeline whose last stage always exits 0 (`npm test | tail -5`): bash reports the last stage's status, so a red test passes
 *     (rule 30694c, confirmed: «Never read `$?` after a pipe … `cmd | tail` always exits 0»);
 *   - a runner flag that turns «no test ran» into a pass (`--passWithNoTests`): a filter with a typo then passes with zero tests
 *     (rule 45b334: «confirm at least one test ran, since --passWithNoTests and a wrong filter …»).
 * Both are pure; contract-lint.ts turns their answers into findings.
 */

/** Programs that exit 0 whatever came in: after a pipe they hide the exit status of the command before it. `grep`, `test`, `jq -e`, `xargs` and `awk` are not here: their status carries information. */
const ALWAYS_ZERO = new Set(["tail", "head", "cat", "tee", "less", "more", "wc", "sort", "uniq", "cut", "tr", "sed", "nl", "fold", "column", "rev"]);

/** The command inside `sh -c '…'` / `bash -c "…"`, or the command itself. */
function unwrapShell(command: string): string {
  const wrapped = /^(?:\/bin\/)?(?:ba|z)?sh\s+(?:-[a-z]*c|-lc)\s+(['"])([\s\S]*)\1$/.exec(command.trim());
  return wrapped ? wrapped[2]! : command;
}

/**
 * The top-level pipelines of a command with the stages of each: split on `&&`, `||`, `;` and newlines, then on a single `|`; quotes,
 * backslashes and `$(…)` / `(…)` groups are skipped so `grep -E 'a|b'` is one stage.
 */
export function pipelinesOf(command: string): string[][] {
  const pipelines: string[][] = [];
  let stages: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let depth = 0;
  const endStage = () => { stages.push(current.trim()); current = ""; };
  const endPipeline = () => { endStage(); pipelines.push(stages.filter(Boolean)); stages = []; };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!, next = command[i + 1];
    if (ch === "\\" && quote !== "'") { current += ch + (next ?? ""); i++; continue; }
    if (quote) { if (ch === quote) quote = null; current += ch; continue; }
    if (ch === "'" || ch === "\"") { quote = ch; current += ch; continue; }
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0) {
      if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) { endPipeline(); i++; continue; }
      if (ch === ";" || ch === "\n") { endPipeline(); continue; }
      if (ch === "|") { endStage(); continue; }
    }
    current += ch;
  }
  endPipeline();
  return pipelines.filter((pipeline) => pipeline.length > 0);
}

const programOf = (stage: string): string => {
  const words = stage.replace(/^(?:\w+=\S*\s+)+/, "").split(/\s+/).filter(Boolean);
  const first = words[0] ?? "";
  return (first === "env" || first === "command" || first === "exec" ? words.find((word, index) => index > 0 && !word.startsWith("-") && !word.includes("=")) ?? "" : first).replace(/^.*\//, "");
};

/**
 * Why a verification command cannot see the failure of the command before a pipe, or null when it can: the last stage of a pipeline
 * is `tail`, `head`, `tee`, … and neither `pipefail` nor `PIPESTATUS` is in the command.
 */
export function maskedExitReason(command: string): string | null {
  const text = unwrapShell(command);
  if (/\bpipefail\b|\bPIPESTATUS\b/.test(text)) return null;
  for (const stages of pipelinesOf(text)) {
    if (stages.length < 2) continue;
    const last = programOf(stages[stages.length - 1]!);
    if (ALWAYS_ZERO.has(last)) {
      return `ends a pipeline in \`${last}\`, which exits 0 whatever the command before the pipe did, so a failing \`${stages[0]!.slice(0, 60)}\` still passes the check`;
    }
  }
  return null;
}

/**
 * Why a runner flag turns «no test ran» into a pass, or null: `--passWithNoTests` / `--pass-with-no-tests` of vitest and jest (also `=true`).
 * Without it a filter with a typo ends with «No test files found» and exit 1, which is the signal the writer needs.
 */
export function passWithNoTestsReason(command: string): string | null {
  const flag = /(?:^|\s)(--pass-?with-?no-?tests)(?:=(?:true|1))?(?=\s|$|['"])/i.exec(unwrapShell(command));
  if (!flag) return null;
  return `passes the runner flag ${flag[1]}, which makes a filter that matches no test file (a typo, a moved test) exit 0 with zero tests run`;
}

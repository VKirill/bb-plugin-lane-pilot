export function formatFixTurnPrompt(input: {
  taskId: string;
  gateCommand: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  logPath: string;
  /** The failing tests your task's diff can have broken (the host checked they pass on the base and live in a workspace the task touched). */
  failingTests?: string[];
  /** Failing tests that also fail on the base commit: not this task's, to be left alone. */
  preexistingTests?: string[];
  /** The run's own «Unhandled Errors» block (gate-output.ts `unhandledErrorBlock`): it fails the run with every test green and sits above the 800-char tail. */
  unhandled?: string | null;
}): string {
  const tail = `${input.stderr}\n${input.stdout}`.trim().slice(-800);
  return `Result: integration gate failed after merging your task ${input.taskId}.
Full check log: ${input.logPath}

→ The integration gate command \`${input.gateCommand}\` exited with code ${input.exitCode}.${input.failingTests?.length ? `\n→ Failing tests your change can have broken: ${input.failingTests.join(", ")}.` : ""}${input.preexistingTests?.length ? `\n→ Also red, but they fail without your change too (not yours, leave them): ${input.preexistingTests.join(", ")}.` : ""}${input.unhandled ? `\n→ The run reported an unhandled error outside any test (it fails the run even with every test green): ${input.unhandled}` : ""}
→ Output tail:
${tail}

Make this pass on main. Change only what your task requires within owns_paths.`;
}

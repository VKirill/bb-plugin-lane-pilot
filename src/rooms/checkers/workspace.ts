import { jev, type JevSettings, type JudgeContext } from "@lane-pilot/jev";
import { hostCommandJudgment } from "@lane-pilot/jev/judgments/host-command";
import { mapVerificationCwd } from "../tasks";
import type { CommandRun, Subject, VerificationSession } from "./checkers";

export type ShellResult = { exitCode: number; stdout: string; stderr: string };

/** A shell on the machine the project lives on (the plugin: `runOnHost`; the live driver: a local shell or ssh). */
export interface ShellPort {
  run(cwd: string, command: string, timeoutSec?: number): Promise<ShellResult>;
}

/** Single-quotes a word for `sh -c`. */
export const quote = (word: string): string => `'${word.replace(/'/g, `'\\''`)}'`;

const TAIL = 4000;
const MAX_FILE_BYTES = 200_000;

/**
 * B3: commands the task contract (an agent's YAML) asks to run pass the `guard.host_command` judgment first — protection
 * from mistakes, not a ban on the agent. Shadow by default (the receipt records what Jev would have done); active, a
 * `stop` decision returns exit 78 and a readable reason instead of running. `review` runs and only marks the receipt.
 */
export function guardShellPort(shell: ShellPort, ctx: () => JudgeContext | undefined): ShellPort {
  return {
    async run(cwd, command, timeoutSec) {
      const judge = jev();
      if (judge) {
        const c = ctx() ?? {};
        const settings = (c as { settings?: JevSettings }).settings;
        const verdict = await judge.judge(hostCommandJudgment, { command, cwd, workspaceRoots: [cwd], task: "" }, c).catch(() => null);
        if (verdict?.by === "jev" && verdict.decision.action === "stop") {
          return { exitCode: 78, stdout: "", stderr: `stopped by jev guard.host_command: ${verdict.decision.reason}` };
        }
      }
      return shell.run(cwd, command, timeoutSec);
    },
  };
}

/**
 * The `node_modules` folders of the live checkout, put into the clone so the checks find their dependencies: a copy-on-write clone on macOS
 * (no extra disk), a symlink elsewhere. The same way the bench warm-up does it.
 */
export const linkDependencies = (repo: string, dir: string): string =>
  `cd ${quote(repo)} && find . -maxdepth 4 -name node_modules -type d -prune -not -path '*/node_modules/*' | while read p; do t=${quote(dir)}/"$p"; if [ ! -e "$t" ] && [ ! -L "$t" ]; then mkdir -p "$(dirname "$t")" && if [ "$(uname)" = Darwin ]; then cp -Rc ${quote(repo)}/"$p" "$t"; else ln -s ${quote(repo)}/"$p" "$t"; fi; fi; done`;

/** The command that writes `content` to `path` in the clone, whatever the text holds (base64 through the shell). */
export const writeFileCommand = (path: string, content: string): string =>
  `mkdir -p "$(dirname ${quote(path)})" && printf %s ${quote(Buffer.from(content, "utf8").toString("base64"))} | (base64 -d 2>/dev/null || base64 -D) > ${quote(path)}`;

export type CloneOptions = {
  /** The project's checkout, and the commit the task started from. */
  repo: string;
  baseSha: string;
  /** A folder for the clone's parent; the clone is removed on close. */
  scratch: string;
  name: string;
  /** Per-check cap in seconds. */
  checkTimeoutSec?: number;
};

/**
 * A clone of the project at the task's base commit in which a subject's files are written and its checks run. Between two subjects the clone
 * is reset to the base commit, so one planted defect never reaches the next.
 */
export async function openClone(shell: ShellPort, options: CloneOptions): Promise<VerificationSession> {
  const work = `${options.scratch}/${options.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60)}-${Date.now().toString(36)}`, dir = `${work}/clone`;
  const made = await shell.run("/", `mkdir -p ${quote(work)} && git clone -q --local --no-checkout ${quote(options.repo)} ${quote(dir)} && git -C ${quote(dir)} checkout -q --detach ${quote(options.baseSha)} && ${linkDependencies(options.repo, dir)}`, 900);
  if (made.exitCode !== 0) {
    await shell.run("/", `rm -rf ${quote(work)}`, 120).catch(() => undefined);
    throw new Error(`clone failed: ${`${made.stdout}\n${made.stderr}`.trim().slice(-300)}`);
  }
  return {
    async run(subject: Subject): Promise<CommandRun[]> {
      const reset = await shell.run(dir, "git reset -q --hard && git clean -fdq -e node_modules", 120);
      if (reset.exitCode !== 0) throw new Error(`reset failed: ${reset.stderr.slice(-200)}`);
      for (const change of subject.changes) {
        if (change.after === change.before) continue;
        if (change.after === null) { await shell.run(dir, `rm -f ${quote(change.path)}`, 30); continue; }
        if (Buffer.byteLength(change.after, "utf8") > MAX_FILE_BYTES) throw new Error(`${change.path} is too large to write (${change.after.length} chars)`);
        const wrote = await shell.run(dir, writeFileCommand(change.path, change.after), 60);
        if (wrote.exitCode !== 0) throw new Error(`could not write ${change.path}: ${wrote.stderr.slice(-200)}`);
      }
      const runs: CommandRun[] = [];
      for (const check of subject.contract.verification) {
        const cwd = mapVerificationCwd(check.cwd, options.repo, dir) ?? dir;
        const timeout = Math.min(check.timeout_sec ?? 900, options.checkTimeoutSec ?? 900);
        const result = await shell.run(dir, `cd ${quote(cwd)} && CI=1 ${check.command}`, timeout).catch((cause: unknown): ShellResult => ({ exitCode: 255, stdout: "", stderr: cause instanceof Error ? cause.message : String(cause) }));
        runs.push({ command: check.command, exitCode: result.exitCode, stdout: result.stdout.slice(-TAIL), stderr: result.stderr.slice(-TAIL) });
      }
      return runs;
    },
    async close() { await shell.run("/", `rm -rf ${quote(work)}`, 300).catch(() => undefined); },
  };
}

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnAsync } from "@lane-pilot/kit";
import { buildFixture } from "./fixture";
import { runScore, type ScoreReport } from "./service";
import { CODE_CHECKERS, DEFECT_CLASSES, EXPECTED_CATCHERS, type CheckerId } from "./types";
import { openClone, type ShellPort } from "./workspace";

/** A shell on this machine: `sh -c`, killed when the time is out. */
export const localShell: ShellPort = {
  async run(cwd, command, timeoutSec = 120) {
    const result = await spawnAsync("/bin/sh", ["-c", command], { cwd, timeout: timeoutSec * 1000, keepEnds: 20_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    return { exitCode: result.status ?? (result.error ? 255 : 1), stdout: result.stdout, stderr: result.error ? `${result.stderr}\n${result.error.message}` : result.stderr };
  },
};

export type DrillReport = {
  ok: boolean;
  problems: string[];
  /** Classes planted in the fixture, and the checker designed to catch each. */
  checked: Array<{ defectClass: string; planted: number; caughtBy: CheckerId[]; designedCatchers: CheckerId[] }>;
  report: ScoreReport;
};

/**
 * The checker drill (SMA «which of your key checks have you seen go red on purpose?»): known defects are planted in the fixture candidates and
 * the code checkers run on them. The drill is red when a checker that is designed to catch a class lets a planted defect of it pass, when a
 * code checker raises something on the clean candidate, or when a class could not be planted at all (a drill that does not exercise a class
 * proves nothing about it). No model, no hub, a few seconds. `blind` makes a checker report nothing, to see the drill go red.
 */
export async function runDrill(options: { shell?: ShellPort; blind?: readonly CheckerId[]; scratch?: string; log?: (line: string) => void } = {}): Promise<DrillReport> {
  const shell = options.shell ?? localShell;
  const root = await mkdtemp(join(options.scratch ?? tmpdir(), "lp-checkers-drill-"));
  try {
    const fixture = await buildFixture(root);
    const report = await runScore({
      openVerification: (candidate) => openClone(shell, { repo: fixture.repo, baseSha: fixture.baseSha, scratch: join(root, "clones"), name: candidate.taskId, checkTimeoutSec: 60 }),
      ...(options.log ? { log: options.log } : {}),
    }, { source: "drill", candidates: fixture.candidates, checkers: CODE_CHECKERS, guaranteed: CODE_CHECKERS, ...(options.blind ? { blind: options.blind } : {}) });

    const problems: string[] = [];
    for (const row of report.scorecard.regressions) {
      problems.push(`${row.checker} did not catch the planted defect ${row.defectId} (${row.defectClass}), the class it is there for: ${report.rows.find((item) => item.defectId === row.defectId)?.summary ?? ""}`);
    }
    for (const row of report.rows) {
      if (row.defectClass === "control" && row.flagged && (CODE_CHECKERS as readonly string[]).includes(row.checker)) problems.push(`${row.checker} raised something on the clean candidate ${row.taskId}: ${row.detail}`);
      if (row.outcome === "error") problems.push(`${row.checker} could not run on ${row.defectId}: ${row.detail}`);
    }
    const checked: DrillReport["checked"] = [];
    for (const defectClass of DEFECT_CLASSES) {
      const designed = EXPECTED_CATCHERS[defectClass];
      const planted = report.scorecard.planted[defectClass] ?? 0;
      const caughtBy = CODE_CHECKERS.filter((checker) => (report.scorecard.classes[defectClass]?.[checker]?.hit ?? 0) > 0);
      checked.push({ defectClass, planted, caughtBy, designedCatchers: [...designed] });
      if (!planted) problems.push(`the class ${defectClass} was not planted in the fixture: its mutator found nothing to mutate`);
    }
    return { ok: problems.length === 0, problems, checked, report };
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function renderDrill(drill: DrillReport): string {
  const lines = drill.checked.map((row) => `${row.defectClass.padEnd(24)} planted ${row.planted}  caught by ${row.caughtBy.join(", ") || "-"}  (designed: ${row.designedCatchers.join(", ")})`);
  lines.push("", drill.ok ? "DRILL GREEN: every designed code catcher caught its planted defects" : `DRILL RED:\n${drill.problems.map((problem) => `- ${problem}`).join("\n")}`);
  return lines.join("\n");
}

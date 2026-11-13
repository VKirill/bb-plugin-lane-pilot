import Database from "better-sqlite3";
import { SANDBOX_PROJECT_ID, isDrillTask } from "../../contracts";
import { formatFloorTuning, tuneFloor } from "./floor-tuning";
import { formatEvalReport, runMemoryEval } from "./memory-eval";
import { formatShelf, runShelfReplay } from "./shelf";
import { exportEvalExtract, loadEvalData } from "./source";
import { runMemoryGate, type MemoryGate } from "./gate";
// Imported, not read from disk: the plugin ships as one bundle and the JSON would not sit next to it.
import gateFixture from "./gate-fixture.json";
import suiteBaseline from "./suite-baseline.json";
import { baselineOf, formatSuite, regressions, runSuite, type SuiteBaseline } from "./suite";
import { formatE2e, runE2e, stubModel, type ModelCall } from "./e2e";
import { formatPublic, loadFactConsolidation, loadLongMemEvalAbstention, runFactConsolidation, runLongMemEvalAbstention } from "./public-sets";

export const MEMORY_EVAL_USAGE = "bb lane-pilot memory-eval [--sizes 30,300,3000] [--seed N] [--scope project|pile] [--shelf] [--floor] [--no-floor] [--north-star] [--gate] [--suite [--write-baseline <file>]] [--e2e [--limit N] [--project <id>] [--stub]] [--longmemeval <file>] [--factcons <file>] [--source <extract.db>] [--export <extract.db>] [--json]";

type Result = { exitCode: number; stdout?: string; stderr?: string };

/**
 * `memory-eval`: reads the live database (or an extract) and prints the report. `--export` writes the extract file and stops, so the
 * run can happen anywhere without the hub's database. The live database is only read.
 * `--north-star` adds the cost per verified result (tokens per accepted task); `--gate` runs the frozen 40-case gate on a scratch
 * database and exits 1 on any leak, overflow, cut rule, miss or error.
 */
export async function runMemoryEvalCommand(live: Pick<Database.Database, "prepare"> | null, argv: readonly string[], migrations: readonly string[], extras: { northStar?: () => unknown; /** The plugin's one-shot analyzer path for `--e2e`, for the project whose host runs it. */ model?: (projectId: string) => ModelCall;
  /** File access for `--write-baseline`, `--longmemeval` and `--factcons`: a room reads no files itself, the script passes `node:fs`. */ io?: { read(path: string): string; write(path: string, text: string): void } } = {}): Promise<Result> {
  try {
    const flags: Record<string, string> = {};
    for (let index = 0; index < argv.length; index++) {
      const hit = /^--([a-z0-9-]+)(?:=(.*))?$/s.exec(argv[index]!);
      if (!hit) throw new Error(`unexpected argument ${argv[index]}\n${MEMORY_EVAL_USAGE}`);
      flags[hit[1]!] = hit[2] ?? (["json", "shelf", "floor", "no-floor", "north-star", "gate", "suite", "e2e", "stub"].includes(hit[1]!) ? "1" : argv[++index] ?? "");
    }
    for (const name of Object.keys(flags)) if (!["sizes", "seed", "scope", "shelf", "floor", "no-floor", "north-star", "gate", "source", "export", "json", "suite", "write-baseline", "e2e", "limit", "project", "stub", "longmemeval", "factcons"].includes(name)) throw new Error(`unknown flag --${name}\n${MEMORY_EVAL_USAGE}`);
    if (flags.gate) {
      const scratch = new Database(":memory:");
      try {
        for (const statement of migrations) scratch.exec(statement);
        const fixture = gateFixture as unknown as MemoryGate;
        const report = runMemoryGate(scratch as never, fixture);
        const bad = report.leaks.length + report.overflows.length + report.cutRules.length + report.misses.length + report.errors.length;
        const stdout = `memory gate: ${report.cases} cases, ${report.leaks.length} leaks, ${report.overflows.length} overflows, ${report.cutRules.length} cut rules, ${report.misses.length} misses, ${report.errors.length} errors${bad ? `\n${JSON.stringify({ leaks: report.leaks, overflows: report.overflows, cutRules: report.cutRules, misses: report.misses, errors: report.errors }, null, 2)}` : ""}`;
        return { exitCode: bad ? 1 : 0, stdout: flags.json ? JSON.stringify(report, null, 2) : stdout };
      } finally { scratch.close(); }
    }
    if (flags.suite) {
      const report = runSuite(migrations);
      if (flags["write-baseline"]) {
        if (!extras.io) throw new Error("--write-baseline writes a file: run it with scripts/memory-eval.ts");
        extras.io.write(flags["write-baseline"], `${JSON.stringify(baselineOf(report, `recorded ${new Date().toISOString().slice(0, 10)} with the stand-in embedding`), null, 2)}\n`);
        return { exitCode: 0, stdout: `${formatSuite(report)}\nbaseline written to ${flags["write-baseline"]}` };
      }
      const baseline = suiteBaseline as SuiteBaseline;
      const bad = regressions(report, baseline);
      if (flags.json) return { exitCode: bad.length ? 1 : 0, stdout: JSON.stringify({ report: { ...report, cases: report.cases.map(({ context: _context, ...rest }) => rest) }, regressions: bad }, null, 2) };
      return { exitCode: bad.length ? 1 : 0, stdout: `${formatSuite(report, baseline)}${bad.length ? `\nREGRESSION:\n${bad.map((line) => `- ${line}`).join("\n")}` : "\nno regression against the baseline"}` };
    }
    if (flags.e2e) {
      // Not in CI: it spends model calls. `--stub` is the dry run with a stand-in model.
      const limit = flags.limit ? Number(flags.limit) : undefined;
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error("--limit is a whole number from 1");
      let call: ModelCall;
      if (flags.stub) call = stubModel;
      else {
        if (!extras.model) throw new Error("--e2e calls a model: run it as `bb lane-pilot memory-eval --e2e --project <id>` where the plugin runs, or add --stub for a dry run with a stand-in model");
        if (!flags.project) throw new Error("--e2e needs --project <id>: the project whose machine and analyzer model run the questions");
        call = extras.model(flags.project);
      }
      const report = await runE2e(migrations, call, { ...(limit ? { limit } : {}) });
      return { exitCode: 0, stdout: flags.json ? JSON.stringify(report, null, 2) : formatE2e(report) };
    }
    if (flags.longmemeval || flags.factcons) {
      if (!extras.io) throw new Error("--longmemeval and --factcons read a downloaded file: run them with scripts/memory-eval.ts");
      const { read } = extras.io;
      const lines: string[] = [];
      if (flags.longmemeval) lines.push(formatPublic(runLongMemEvalAbstention(migrations, loadLongMemEvalAbstention(flags.longmemeval, read))));
      if (flags.factcons) lines.push(formatPublic(runFactConsolidation(migrations, loadFactConsolidation(flags.factcons, read))));
      return { exitCode: 0, stdout: lines.join("\n") };
    }
    if (flags.export) {
      if (!live) throw new Error("--export reads the live database; run it where the plugin runs");
      return { exitCode: 0, stdout: JSON.stringify(exportEvalExtract(live, flags.export)) };
    }
    const sizes = flags.sizes ? flags.sizes.split(",").map((item) => Number(item.trim())) : [30, 300, 3000];
    if (!sizes.length || sizes.some((size) => !Number.isInteger(size) || size < 10 || size > 20_000)) throw new Error("--sizes is a list of numbers from 10 to 20000");
    const seed = flags.seed ? Number(flags.seed) : 1;
    if (!Number.isInteger(seed)) throw new Error("--seed is a whole number");
    const scope = flags.scope ?? "project";
    if (scope !== "project" && scope !== "pile") throw new Error("--scope is project (notes stay in their own project, as production keeps them) or pile (one person's memory in one scope)");
    let source: Pick<Database.Database, "prepare"> | null = live;
    let opened: Database.Database | null = null;
    if (flags.source) { opened = new Database(flags.source, { readonly: true }); source = opened; }
    if (!source) throw new Error(`no data: pass --source <extract.db> (made by --export)\n${MEMORY_EVAL_USAGE}`);
    try {
      if (flags.shelf) {
        const results = await runShelfReplay(loadEvalData(source), migrations, { projects: new Set([SANDBOX_PROJECT_ID]), task: isDrillTask });
        return { exitCode: 0, stdout: flags.json ? JSON.stringify(results, null, 2) : formatShelf(results) };
      }
      if (flags.floor) {
        const tuned = await tuneFloor(loadEvalData(source), { sizes, seed, scope, skipProjects: new Set([SANDBOX_PROJECT_ID]), skipTask: isDrillTask, migrations });
        return { exitCode: 0, stdout: formatFloorTuning(tuned) };
      }
      const report = await runMemoryEval(loadEvalData(source), { sizes, seed, scope, ...(flags["no-floor"] ? { floor: null } : {}), skipProjects: new Set([SANDBOX_PROJECT_ID]), skipTask: isDrillTask, migrations });
      const northStar = flags["north-star"] && extras.northStar ? extras.northStar() : null;
      if (flags.json) return { exitCode: 0, stdout: JSON.stringify(northStar ? { report, northStar } : report, null, 2) };
      const star = northStar ? `\ncost per verified result (tokens per accepted task):\n${(northStar as Array<{ projectId: string; tokens: number; accepted: number; tokensPerAccepted: number | null }>).map((row) => `- ${row.projectId}: ${row.tokensPerAccepted ?? "—"} tokensPerAccepted (${row.accepted} accepted, ${row.tokens} tokens)`).join("\n")}` : "";
      return { exitCode: 0, stdout: `${formatEvalReport(report)}${star}` };
    } finally { opened?.close(); }
  } catch (cause) {
    return { exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause) };
  }
}

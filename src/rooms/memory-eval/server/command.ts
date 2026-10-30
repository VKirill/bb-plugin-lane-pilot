import Database from "better-sqlite3";
import { SANDBOX_PROJECT_ID, isDrillTask } from "../../stability/server";
import { formatFloorTuning, tuneFloor } from "./floor-tuning";
import { formatEvalReport, runMemoryEval } from "./memory-eval";
import { formatShelf, runShelfReplay } from "./shelf";
import { exportEvalExtract, loadEvalData } from "./source";

export const MEMORY_EVAL_USAGE = "bb lane-pilot memory-eval [--sizes 30,300,3000] [--seed N] [--scope project|pile] [--shelf] [--floor] [--no-floor] [--source <extract.db>] [--export <extract.db>] [--json]";

type Result = { exitCode: number; stdout?: string; stderr?: string };

/**
 * `memory-eval`: reads the live database (or an extract) and prints the report. `--export` writes the extract file and stops, so the
 * run can happen anywhere without the hub's database. The live database is only read.
 */
export async function runMemoryEvalCommand(live: Pick<Database.Database, "prepare"> | null, argv: readonly string[]): Promise<Result> {
  try {
    const flags: Record<string, string> = {};
    for (let index = 0; index < argv.length; index++) {
      const hit = /^--([a-z-]+)(?:=(.*))?$/s.exec(argv[index]!);
      if (!hit) throw new Error(`unexpected argument ${argv[index]}\n${MEMORY_EVAL_USAGE}`);
      flags[hit[1]!] = hit[2] ?? (["json", "shelf", "floor", "no-floor"].includes(hit[1]!) ? "1" : argv[++index] ?? "");
    }
    for (const name of Object.keys(flags)) if (!["sizes", "seed", "scope", "shelf", "floor", "no-floor", "source", "export", "json"].includes(name)) throw new Error(`unknown flag --${name}\n${MEMORY_EVAL_USAGE}`);
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
        const results = await runShelfReplay(loadEvalData(source), { projects: new Set([SANDBOX_PROJECT_ID]), task: isDrillTask });
        return { exitCode: 0, stdout: flags.json ? JSON.stringify(results, null, 2) : formatShelf(results) };
      }
      if (flags.floor) {
        const tuned = await tuneFloor(loadEvalData(source), { sizes, seed, scope, skipProjects: new Set([SANDBOX_PROJECT_ID]), skipTask: isDrillTask });
        return { exitCode: 0, stdout: formatFloorTuning(tuned) };
      }
      const report = await runMemoryEval(loadEvalData(source), { sizes, seed, scope, ...(flags["no-floor"] ? { floor: null } : {}), skipProjects: new Set([SANDBOX_PROJECT_ID]), skipTask: isDrillTask });
      return { exitCode: 0, stdout: flags.json ? JSON.stringify(report, null, 2) : formatEvalReport(report) };
    } finally { opened?.close(); }
  } catch (cause) {
    return { exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause) };
  }
}

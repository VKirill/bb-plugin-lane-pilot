import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkReceipt, coverageRows, codeNodes, holes, summarize, type CoverageRow, type DrillReceipt } from "./model";
import { NODE_KINDS } from "./registry";

export const COVERAGE_USAGE = "bb lane-pilot coverage [--json] [--kind stage|transition|failure_class|gate|memory_path|room|mechanism] [--status live|tests|none] [--receipt <drill receipt.json|latest>]   what proves each stage and mechanism: covered live by a drill scenario / by tests only / not covered, with the reason";

type Result = { exitCode: number; stdout?: string; stderr?: string };
const LABEL: Record<CoverageRow["status"], string> = { live: "live ", tests: "tests", none: "NONE " };
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function flagValue(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

function loadReceipt(spec: string, cwd: string): { path: string; receipt: DrillReceipt } {
  let path = spec;
  if (spec === "latest") {
    const dir = join(cwd, ".agents", "runs", "drills");
    const files = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")).sort() : [];
    if (!files.length) throw new Error(`no drill receipt in ${dir}`);
    path = join(dir, files[files.length - 1]!);
  }
  return { path, receipt: JSON.parse(readFileSync(path, "utf8")) as DrillReceipt };
}

export function renderCoverage(rows: readonly CoverageRow[]): string {
  const summary = summarize(rows);
  const all = summary.all;
  const lines = [`Lane Pilot coverage: ${all.total} nodes — covered live ${all.live}, by tests only ${all.tests}, not covered ${all.none}.`, "", "kind            live  tests  none  total"];
  for (const kind of NODE_KINDS) {
    const row = summary[kind];
    if (row) lines.push(`${kind.padEnd(15)} ${String(row.live).padStart(4)}  ${String(row.tests).padStart(5)}  ${String(row.none).padStart(4)}  ${String(row.total).padStart(5)}`);
  }
  lines.push("");
  for (const row of rows) {
    const where = row.live.length ? `drill: ${row.live.join(", ")}` : row.tests.length ? `tests: ${row.tests.slice(0, 2).join(", ")}${row.tests.length > 2 ? ` +${row.tests.length - 2}` : ""}` : "no test";
    lines.push(`${LABEL[row.status]}  ${row.kind}:${row.id}  ${where}${row.note ? `  — ${row.status === "live" ? "" : row.status === "none" ? "not covered: " : "not live: "}${clip(row.note, 140)}` : ""}`);
  }
  return lines.join("\n");
}

export function runCoverageCli(argv: string[], cwd: string = process.cwd()): Result {
  try {
    const kind = flagValue(argv, "--kind"), status = flagValue(argv, "--status"), receiptSpec = flagValue(argv, "--receipt");
    if (kind && !(NODE_KINDS as readonly string[]).includes(kind)) throw new Error(`--kind is one of ${NODE_KINDS.join(", ")}`);
    if (status && !["live", "tests", "none"].includes(status)) throw new Error("--status is live, tests or none");
    const all = coverageRows();
    const rows = all.filter((row) => (!kind || row.kind === kind) && (!status || row.status === status));
    const problems = holes(all, codeNodes());
    const gaps = [...problems.missing.map((node) => `${node}: in the code, no registry entry`), ...problems.stale.map((node) => `${node}: registry entry for a node the code no longer lists`), ...problems.duplicate.map((node) => `${node}: two entries`)];
    const checked = receiptSpec ? loadReceipt(receiptSpec, cwd) : null;
    const verdict = checked ? { path: checked.path, ...checkReceipt(all, checked.receipt) } : null;
    if (argv.includes("--json")) return { exitCode: gaps.length ? 1 : 0, stdout: JSON.stringify({ summary: summarize(all), rows, gaps, receipt: verdict }, null, 2) };
    const out = [renderCoverage(rows)];
    if (gaps.length) out.push("", `Registry holes (${gaps.length}):`, ...gaps.map((gap) => `  ${gap}`));
    if (verdict) {
      out.push("", `Receipt ${verdict.path}:`);
      out.push(verdict.evidence ? `  ${verdict.confirmed} of ${verdict.checked} live claims it can speak to are confirmed by what the run left on the hub${verdict.notSeen.length ? "; not seen:" : "."}` : `  ${verdict.skipped}`);
      for (const line of verdict.notSeen) out.push(`    ${line}`);
    }
    return { exitCode: gaps.length || verdict?.notSeen.length ? 1 : 0, stdout: out.join("\n") };
  } catch (cause) {
    return { exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause) };
  }
}

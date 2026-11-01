import type { LanePilotDatabase } from "../storage";
import { examAll, type Verdict } from "./logic";
import { backtest } from "./server/backtest";
import { examRows, labelDecision, listDecisions } from "./server/journal";

export const LEAD_USAGE = [
  "bb lane-pilot lead journal [--class <c>] [--surface <s>] [--last N] [--json]   the decision journal: situation, prediction, answer, verdict (newest first)",
  "bb lane-pilot lead exam [--json]                 the exam per class: N, decided, Wilson LB, coverage, kappa, tier it would earn (no right is granted yet)",
  "bb lane-pilot lead backtest [--json]             replay the owner's past words (tasks, phases) through the predictor; split backtest, never in the exam",
  "bb lane-pilot lead label <decision-id> exact|partial|miss|deferred   the owner's own verdict on a judged row (the judge's kappa is measured against it)",
].join("\n");

type Result = { exitCode: number; stdout?: string; stderr?: string };
const json = (value: unknown) => JSON.stringify(value, null, 2);
const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const pct = (value: number | null) => (value === null ? "—" : `${Math.round(value * 100)}%`);

export async function runLeadCli(ctx: { db: LanePilotDatabase; kv: { get(key: string): Promise<unknown> } }, argv: string[], now: number = Date.now()): Promise<Result> {
  const [command, ...rest] = argv;
  const asJson = rest.includes("--json");
  if (command === "journal") {
    const rows = listDecisions(ctx.db, { class: flag(rest, "--class"), surface: flag(rest, "--surface"), limit: Number(flag(rest, "--last") ?? 30) });
    if (asJson) return { exitCode: 0, stdout: json(rows) };
    const lines = rows.map((row) => {
      const predicted = row.prediction_json ? (JSON.parse(row.prediction_json) as { option: string | null; p: number }) : null;
      const answer = row.answer_json ? (JSON.parse(row.answer_json) as { option: string }).option : "—";
      return `${new Date(row.created_at).toISOString().slice(0, 16)} ${row.split.padEnd(8)} ${row.class.padEnd(8)} ${row.id}\n    predicted ${predicted?.option ?? "—"}${predicted ? ` (p ${predicted.p.toFixed(2)})` : ""}, answered ${answer}${row.answered_by ? ` by ${row.answered_by}` : ""} → ${row.judge_verdict ?? "open"}${row.owner_label ? `, owner says ${row.owner_label}` : ""}`;
    });
    return { exitCode: 0, stdout: lines.length ? lines.join("\n") : "The journal is empty: no surface has asked the owner since the lead room appeared." };
  }
  if (command === "exam") {
    const exams = examAll(examRows(ctx.db));
    if (asJson) return { exitCode: 0, stdout: json(exams) };
    if (!exams.length) return { exitCode: 0, stdout: "No class has an exam yet: a row counts only when it was predicted before the owner answered (split exam)." };
    return { exitCode: 0, stdout: exams.map((exam) => `${exam.class}: N ${exam.n}, decided ${exam.k}, matches ${exam.m}, Wilson LB ${pct(exam.wilsonLb)}, coverage ${pct(exam.coverage)}, kappa ${exam.kappa === null ? "—" : exam.kappa.toFixed(2)} (${exam.labeled} labels), high-risk misses ${exam.highRiskMiss} → would ${exam.tier}${exam.reasons.length ? ` (${exam.reasons.join("; ")})` : ""}${exam.revert ? "; last 20 degraded" : ""}`).join("\n") };
  }
  if (command === "backtest") {
    const report = await backtest(ctx.db, ctx.kv, now);
    if (asJson) return { exitCode: 0, stdout: json(report) };
    return { exitCode: 0, stdout: [`Replayed ${report.created} new decision(s); skipped ${report.skipped.length}.`,
      ...report.classes.map((row) => `${row.class}: ${row.n} decisions, predictor decided ${row.decided} (exact ${row.exact}, miss ${row.miss}), deferred ${row.deferred}, accuracy ${pct(row.accuracy)}`),
      ...(report.skipped.length ? ["skipped:", ...report.skipped.map((line) => `  ${line}`)] : []), "Split backtest: a measurement, never a row of the exam and never a right."].join("\n") };
  }
  if (command === "label") {
    const [id, label] = rest;
    if (!id || !["exact", "partial", "miss", "deferred"].includes(label ?? "")) return { exitCode: 2, stderr: LEAD_USAGE };
    return labelDecision(ctx.db, id, label as Verdict, now) ? { exitCode: 0, stdout: `${id}: owner label ${label}` } : { exitCode: 1, stderr: `${id}: no answered decision with that id` };
  }
  return { exitCode: 2, stderr: LEAD_USAGE };
}

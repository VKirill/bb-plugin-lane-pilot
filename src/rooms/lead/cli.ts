import type { LanePilotDatabase } from "../storage";
import { examAll, type Verdict } from "./logic";
import { backtest } from "./server/backtest";
import { formatMemoryExam } from "./server/memory-exam";
import { examRows, labelDecision, listDecisions } from "./server/journal";
import { addRoad, renderRoadTree, roadTree } from "./server/road";
import type { LeadApi } from "./server/service";

export const LEAD_USAGE = [
  "bb lane-pilot lead status [--json]              the lead («Штурман»): on or off, next and last ticks, the road's counts, open proposals, the tier of every class, journal counts",
  "bb lane-pilot lead road [--tree] [--history] [--project <id>|--hub] [--json]   the road tree (open branches; --history adds rejected and done with their reasons)",
  "bb lane-pilot lead road add <direction|option> \"<title>\" --why \"<reason>\" [--parent <road-id>] [--project <id>] [--source owner|lead]",
  "bb lane-pilot lead road reject <road-id> --why \"<reason>\"   |   bb lane-pilot lead road done <road-id> [--note \"…\"]",
  "bb lane-pilot lead decide <road-id> yes|later|no [words…] [--by agent]   the owner's own answer to a proposal (an agent answering for him passes --by agent) (the same as the buttons on «Ждут владельца»); yes hands a project branch to its PM; --by agent marks a proxy answer that never counts for the exam",
  "bb lane-pilot lead ticks [--last N] [--json]    the receipts of the last ticks: status, proposed, acted, cost",
  "bb lane-pilot lead tick-now                     one tick outside the cron (the graph lead-tick runs; its receipt appears in ticks)",
  "bb lane-pilot lead enable on|off                the switch of the ticks (lead.enabled); the word is a row of the journal",
  "bb lane-pilot lead priority [<project-id>…]     the owner's order of projects (lead.priority): the brief ranks them so, unlisted follow; no ids clears it",
  "bb lane-pilot lead rights [--json]              the tier of every class (decides | proposes | owner_only) with the exam numbers behind it; only the nightly exam moves it",
  "bb lane-pilot lead journal [--class <c>] [--surface <s>] [--last N] [--json]   the decision journal: situation, prediction, answer, verdict (newest first)",
  "bb lane-pilot lead exam [--json]                 the exam per class: N, decided, Wilson LB, coverage, kappa, tier it would earn",
  "bb lane-pilot lead backtest [--json]             replay the owner's past words (tasks, phases) through the predictor; split backtest, never in the exam",
  "bb lane-pilot lead label <decision-id> exact|partial|miss   the owner's own verdict on a judged exam row he answered himself (the judge's kappa is measured against it)",
  "bb lane-pilot lead memory-exam [--limit N] [--no-recall] [--json]   the memory exam: recall probes on the hub's accepted tasks and the answered rows predicted again with the lead's memory and with none (the control); runs itself on Sunday 05:10",
].join("\n");

type Result = { exitCode: number; stdout?: string; stderr?: string };
export type LeadCliContext = { db: LanePilotDatabase; kv: { get(key: string): Promise<unknown> }; lead?: LeadApi };
const json = (value: unknown) => JSON.stringify(value, null, 2);
const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const pct = (value: number | null) => (value === null ? "—" : `${Math.round(value * 100)}%`);
const when = (ms: number | null) => (ms === null ? "—" : new Date(ms).toISOString().slice(0, 16).replace("T", " "));
const needService = (ctx: LeadCliContext): LeadApi => { if (!ctx.lead) throw new Error("this command needs the running plugin (bb lane-pilot lead … from a machine with Lane Pilot active)"); return ctx.lead; };

export async function runLeadCli(ctx: LeadCliContext, argv: string[], now: number = Date.now()): Promise<Result> {
  const [command, ...rest] = argv;
  const asJson = rest.includes("--json");
  try {
    if (command === "status") {
      const state = await needService(ctx).state(now);
      if (asJson) return { exitCode: 0, stdout: json(state) };
      const last = state.ticks[0];
      return { exitCode: 0, stdout: [
        `Штурман: ticks ${state.settings.enabled ? "on" : "off"}${state.settings.enabled ? `, next ${when(state.nextTickAt)}` : ""}; cron ${state.settings.tickCron}; budget $${state.settings.budgetDailyUsd}/day; home project ${state.homeProjectId}; zone ${state.settings.projects.length ? state.settings.projects.join(", ") : "every project"}`,
        `identity ${state.identity.sha.slice(0, 12)} (${state.identity.bytes} B${state.identity.seeded ? ", seeded now" : ""}) at ${state.identity.path}`,
        `road: open ${state.road.open ?? 0}, proposed ${state.road.proposed ?? 0}, accepted ${state.road.accepted ?? 0}, later ${state.road.later ?? 0}, rejected ${state.road.rejected ?? 0}, done ${state.road.done ?? 0}; proposals on the owner's list ${state.proposalsOpen}`,
        `journal: ${state.journal.total} rows (${state.journal.exam} exam, ${state.journal.backtest} backtest)`,
        `memory exam: ${state.memoryExam ? formatMemoryExam(state.memoryExam).split("\n").slice(1, 3).join("; ") : "not run yet (bb lane-pilot lead memory-exam)"}`,
        `last tick: ${last ? `${last.id} ${last.status} at ${when(last.started_at)}` : "none"}${state.running ? `; running ${state.running.id}` : ""}`,
        `rights: ${state.rights.map((row) => `${row.class}=${row.tier}`).join(", ")}`,
        state.lastExam ? `last exam ${when(state.lastExam.at)}: ${state.lastExam.changes.length ? state.lastExam.changes.map((change) => `${change.class} ${change.from}→${change.to}`).join(", ") : "no change"}` : "last exam: not yet",
      ].join("\n") };
    }
    if (command === "road") {
      const [sub] = rest;
      if (sub === "add") {
        const kind = rest[1] === "direction" || rest[1] === "option" ? rest[1] : null;
        const title = rest[2];
        const why = flag(rest, "--why");
        if (!kind || !title || !why) return { exitCode: 2, stderr: LEAD_USAGE };
        const source = flag(rest, "--source") === "owner" ? "owner" : "lead";
        const row = addRoad(ctx.db, { parentId: flag(rest, "--parent") ?? null, projectId: flag(rest, "--project") ?? null, title, kind, source, why }, now);
        return { exitCode: 0, stdout: `${row.id}: ${row.kind} «${row.title}» open (${row.source})` };
      }
      if (sub === "reject") {
        const why = flag(rest, "--why");
        if (!rest[1] || !why) return { exitCode: 2, stderr: LEAD_USAGE };
        return needService(ctx).settle(rest[1], "reject", "owner", why, now) ? { exitCode: 0, stdout: `${rest[1]}: rejected` } : { exitCode: 1, stderr: `${rest[1]}: not open, proposed or later (or unknown)` };
      }
      if (sub === "done") {
        if (!rest[1]) return { exitCode: 2, stderr: LEAD_USAGE };
        return needService(ctx).settle(rest[1], "done", "owner", flag(rest, "--note"), now) ? { exitCode: 0, stdout: `${rest[1]}: done` } : { exitCode: 1, stderr: `${rest[1]}: cannot be marked done from its state (or unknown)` };
      }
      const project = flag(rest, "--project");
      const nodes = roadTree(ctx.db, { ...(rest.includes("--hub") ? { projectId: null } : project ? { projectId: project } : {}), history: rest.includes("--history") });
      if (asJson) return { exitCode: 0, stdout: json(nodes) };
      return { exitCode: 0, stdout: renderRoadTree(nodes) || "The road tree is empty: add a direction with `bb lane-pilot lead road add direction \"…\" --why \"…\"` or let a tick fill it." };
    }
    if (command === "decide") {
      const [roadId, decision, ...tail] = rest;
      if (!roadId || !["yes", "later", "no"].includes(decision ?? "")) return { exitCode: 2, stderr: LEAD_USAGE };
      // `--by agent`: an agent answering for the owner; the row is kept but never counts for the exam (OWNER_ANSWERERS).
      const by = flag(tail, "--by") ?? "owner";
      if (by === "screen" || by === "owner via screen") return { exitCode: 2, stderr: "--by screen is the list's buttons, not a terminal: an agent answering for the owner passes --by agent" };
      const words = tail.filter((arg, i) => arg !== "--by" && tail[i - 1] !== "--by");
      const result = await needService(ctx).decide(roadId, decision as "yes" | "later" | "no", words.join(" ") || undefined, by, now);
      if (!result.ok) return { exitCode: 1, stderr: result.reason };
      const handover = result.handover ? (result.handover.state === "started" ? `; work started: ${result.handover.via} ${result.handover.id}` : `; hand-over ${result.handover.state}: ${result.handover.reason}`) : "";
      return { exitCode: 0, stdout: `${roadId}: ${result.road.state}${result.verdict ? ` (the lead's prediction was ${result.verdict})` : ""}${handover}` };
    }
    if (command === "ticks") {
      const state = await needService(ctx).state(now);
      const rows = state.ticks.slice(0, Number(flag(rest, "--last") ?? 10));
      if (asJson) return { exitCode: 0, stdout: json(rows) };
      if (!rows.length) return { exitCode: 0, stdout: "No tick yet: switch lead.enabled on or run `bb lane-pilot lead tick-now`." };
      return { exitCode: 0, stdout: rows.map((row) => `${when(row.started_at)} ${row.id} ${row.status.padEnd(10)} ${row.trigger.padEnd(6)} proposed ${JSON.parse(row.proposed_json ?? "[]").length}, acted ${JSON.parse(row.acted_json ?? "[]").length}, $${((row.cost_micro_usd ?? 0) / 1_000_000).toFixed(2)}${row.wf_run_id ? ` run ${row.wf_run_id}` : ""}`).join("\n") };
    }
    if (command === "tick-now") {
      const result = await needService(ctx).runTick("manual", now);
      return result.ok ? { exitCode: 0, stdout: `tick ${result.tickId} started (workflow run ${result.runId}); read it with bb lane-pilot lead ticks` } : { exitCode: 1, stderr: `tick not started: ${result.reason}` };
    }
    if (command === "enable") {
      if (rest[0] !== "on" && rest[0] !== "off") return { exitCode: 2, stderr: LEAD_USAGE };
      needService(ctx).setEnabled(rest[0] === "on", "owner", now);
      return { exitCode: 0, stdout: `lead.enabled = ${rest[0]}` };
    }
    if (command === "priority") {
      const ids = needService(ctx).setPriority(rest.filter((arg) => !arg.startsWith("--")));
      return { exitCode: 0, stdout: ids.length ? `lead.priority = ${ids.join(", ")}` : "lead.priority cleared: the hub's order" };
    }
    if (command === "rights") {
      const state = await needService(ctx).state(now);
      if (asJson) return { exitCode: 0, stdout: json(state.rights) };
      return { exitCode: 0, stdout: state.rights.map((row) => `${row.class.padEnd(10)} ${row.tier.padEnd(10)} (starts ${row.start}, acts via ${row.actsVia})${row.exam ? ` N ${row.exam.n ?? 0}, decided ${row.exam.k ?? 0}, LB ${pct(row.exam.wilson_lb)}, coverage ${pct(row.exam.coverage)}, since ${when(row.exam.since)}${JSON.parse(row.exam.reasons_json).length ? `; ${(JSON.parse(row.exam.reasons_json) as string[]).join("; ")}` : ""}` : " — no exam yet"}`).join("\n") };
    }
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
    if (command === "memory-exam") {
      const limitRaw = flag(rest, "--limit");
      const limit = limitRaw ? Number(limitRaw) : undefined;
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) return { exitCode: 2, stderr: LEAD_USAGE };
      const exam = await needService(ctx).memoryExam({ ...(limit ? { limit } : {}), recall: !rest.includes("--no-recall") }, now);
      return { exitCode: 0, stdout: asJson ? json(exam) : formatMemoryExam(exam) };
    }
    if (command === "label") {
      const [id, label] = rest;
      if (!id || !["exact", "partial", "miss"].includes(label ?? "")) return { exitCode: 2, stderr: LEAD_USAGE };
      return labelDecision(ctx.db, id, label as Exclude<Verdict, "deferred">, now) ? { exitCode: 0, stdout: `${id}: owner label ${label}` } : { exitCode: 1, stderr: `${id}: no judged exam row the owner answered himself has that id (a deferred, proxy, backtest or design row takes no label)` };
    }
  } catch (cause) {
    return { exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause) };
  }
  return { exitCode: 2, stderr: LEAD_USAGE };
}

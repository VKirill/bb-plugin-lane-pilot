import { classifyUnformed, listRuleForms, markMechanized, RULE_FORMS, type RuleFormRow, type RulesDatabase } from "@lane-pilot/run-insights";
import { applyJevForms, type FormAsk } from "./jev-forms";
import { MECHANISMS, mechanismFor } from "./mechanisms";
import { listPromotions, proposePromotions } from "./promotion";

export const RULES_USAGE = [
  "bb lane-pilot rules forms [project] [--form check|hook|skill|memory|always] [--state accepted|proposed|all] [--json]   the rules by form, with the mechanism that enforces each",
  "bb lane-pilot rules classify [project] [--all] [--jev --host <host-id>] [--dry]   give every rule without a form one (heuristics first, System One for the undecided rest); --dry writes nothing",
  "bb lane-pilot rules promote <project> [--repo <path>] [--list] [--json]   task contracts for the recurring check/hook rules (stored for the night loop, nothing dispatched)",
  "bb lane-pilot rules mechanize [project] [--apply]   rules that a mechanism of this repository fully refuses: record it and retire their text from the brief (dry without --apply)",
].join("\n");

export type RulesCliDeps = {
  db: RulesDatabase;
  now?(): number;
  /** Takes a rule out of force with the reason on its journal (self-repair/server retireAdoptedRule). */
  retire(projectId: string, ruleId: string, reason: string): void;
  /** One System One call; absent when no host can be asked. */
  ask?: FormAsk | null;
  /** The checkout the promotion contracts are written against. */
  repoPath: string;
};

type Out = { exitCode: number; stdout?: string; stderr?: string };
const json = (value: unknown) => JSON.stringify(value, null, 2);
const clip = (text: string, max: number) => { const flat = text.replace(/\s+/g, " ").trim(); return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat; };

/** Flags with a value (`--form check`) and without; the words left over are positional. */
function parse(args: string[], withValue: readonly string[]): { positional: string[]; flags: Map<string, string | true> } {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const [name, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
    flags.set(name, inline ?? (withValue.includes(name) ? args[++i] ?? true : true));
  }
  return { positional, flags };
}

export function formDistribution(rows: ReadonlyArray<Pick<RuleFormRow, "form" | "state">>): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const row of rows) {
    const form = row.form ?? "none";
    out[form] ??= {};
    out[form]![row.state] = (out[form]![row.state] ?? 0) + 1;
    out[form]!.total = (out[form]!.total ?? 0) + 1;
  }
  return out;
}

function renderForms(rows: RuleFormRow[]): string {
  const lines: string[] = [];
  for (const form of [...RULE_FORMS, null] as const) {
    const part = rows.filter((row) => (row.form ?? null) === form);
    if (!part.length) continue;
    const held = part.filter((row) => row.mechanizedBy).length;
    lines.push(`${form ?? "(no form)"}  ${part.length} rules${held ? `, ${held} held by a mechanism` : ""}`);
    for (const row of part) {
      lines.push(`  ${row.id.slice(0, 13)}  ${row.state.slice(0, 3)}  x${row.occurrences}${row.trialState ? `  ${row.trialState}` : ""}  ${clip(row.rule, 110)}`);
      if (row.mechanizedBy) lines.push(`      mechanized_by: ${row.mechanizedBy}`);
      else if (row.formReason && form !== "always") lines.push(`      ${row.formReason}${row.formBy ? ` (${row.formBy})` : ""}`);
    }
  }
  return lines.join("\n");
}

export async function runRulesCli(deps: RulesCliDeps, args: string[]): Promise<Out> {
  const now = deps.now?.() ?? Date.now();
  try {
    const [op = "forms", ...rest] = args;
    const { positional, flags } = parse(rest, ["form", "state", "repo"]);
    const projectId = positional[0] ?? null;
    if (op === "forms") {
      const state = flags.get("state");
      const states = state === "all" ? ["proposed", "accepted", "rejected", "revoked"] : typeof state === "string" ? [state] : ["accepted", "proposed"];
      const wanted = flags.get("form");
      const rows = listRuleForms(deps.db, projectId, states).filter((row) => typeof wanted !== "string" || (wanted === "none" ? !row.form : row.form === wanted));
      if (flags.has("json")) return { exitCode: 0, stdout: json({ distribution: formDistribution(rows), rules: rows }) };
      const dist = formDistribution(rows);
      return { exitCode: 0, stdout: `${renderForms(rows)}\n\n${rows.length} rules (${states.join("+")}): ${Object.entries(dist).map(([form, counts]) => `${form} ${counts.total}`).join(", ") || "none"}` };
    }
    if (op === "classify") {
      const dry = flags.has("dry");
      const results = classifyUnformed(deps.db, projectId, { all: flags.has("all"), dry }, now);
      let jev: { asked: number; moved: number } | null = null;
      const undecided = results.filter((result) => !result.verdict.decided).map((result) => result.row);
      if (flags.has("jev") && !dry && undecided.length) {
        jev = deps.ask ? await applyJevForms(deps.db, undecided, deps.ask, now) : { asked: 0, moved: 0 };
      }
      const counts: Record<string, number> = {};
      for (const result of results) counts[result.verdict.form] = (counts[result.verdict.form] ?? 0) + 1;
      return { exitCode: 0, stdout: json({ dry, classified: results.length, byForm: counts, decided: results.length - undecided.length, undecided: undecided.length, jev: flags.has("jev") ? jev ?? "skipped (dry)" : "not asked",
        undecidedRules: undecided.slice(0, 20).map((row) => ({ id: row.id, rule: clip(row.rule, 120) })) }) };
    }
    if (op === "promote") {
      if (!projectId) return { exitCode: 1, stderr: `promote needs a project id\n${RULES_USAGE}` };
      const repo = typeof flags.get("repo") === "string" ? String(flags.get("repo")) : deps.repoPath;
      const result = flags.has("list") ? null : proposePromotions(deps.db, projectId, { repoPath: repo, now });
      const rows = listPromotions(deps.db, projectId);
      if (flags.has("json")) return { exitCode: 0, stdout: json({ created: result?.created.length ?? 0, candidates: result?.candidates ?? null, promotions: rows }) };
      return { exitCode: 0, stdout: [
        result ? `${result.created.length} new, ${result.kept} already stored, ${result.candidates} recurring check/hook rules` : "stored",
        ...rows.map((row) => `  ${row.ruleId.slice(0, 13)}  ${row.state.padEnd(10)} ${row.tier.padEnd(14)} ${row.mechanism.padEnd(16)} ${row.task.id}  ${clip(row.task.title, 80)}`),
      ].join("\n") };
    }
    if (op === "mechanize") {
      const apply = flags.has("apply");
      const rows = listRuleForms(deps.db, projectId, ["accepted", "proposed"]).filter((row) => !row.mechanizedBy);
      const found = rows.flatMap((row) => { const mechanism = mechanismFor(row.rule); return mechanism ? [{ row, mechanism }] : []; });
      const full = found.filter((item) => item.mechanism.coverage === "full");
      if (apply) {
        for (const { row, mechanism } of full) {
          markMechanized(deps.db, row.projectId, row.id, mechanism.ref, now);
          if (row.state === "accepted") deps.retire(row.projectId, row.id, `mechanized by ${mechanism.ref}`);
        }
      }
      return { exitCode: 0, stdout: json({ applied: apply, registry: MECHANISMS.length,
        held: full.map(({ row, mechanism }) => ({ id: row.id, state: row.state, mechanism: mechanism.id, rule: clip(row.rule, 100), chars: row.rule.length })),
        partial: found.filter((item) => item.mechanism.coverage === "partial").map(({ row, mechanism }) => ({ id: row.id, mechanism: mechanism.id, gap: mechanism.gap })),
        briefCharsFreed: apply ? full.filter((item) => item.row.state === "accepted").reduce((sum, item) => sum + item.row.rule.length + 3, 0) : 0,
        briefCharsWouldFree: full.filter((item) => item.row.state === "accepted").reduce((sum, item) => sum + item.row.rule.length + 3, 0) }) };
    }
    return { exitCode: 1, stderr: `unknown rules operation «${op}»\n${RULES_USAGE}` };
  } catch (cause) {
    return { exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause) };
  }
}


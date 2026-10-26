import { z } from "zod";
import { brokenWireReason, type WireResult } from "../wires";

/**
 * The plan against the fact (SMA plan P1-3, Maslov #30971: «never read the executor's story»).
 *
 * The writer closes its answer with a table: one row per `acceptance` item of the contract, with the evidence for it. Code, not a
 * model, then checks every piece of evidence against the candidate, and never reads the prose around the table:
 * - `path` or `path:first-last`: the file is among the changed files, and the lines overlap a changed hunk of it;
 * - `cmd:<command>`: the command is one of the contract's `verification[]` commands, and it ran with exit code 0.
 * A `done` row with no piece of evidence that holds is `unproven` and blocks that acceptance item.
 * An item of the contract that says something stays as it was («legacy responses unchanged», «X still works») is proven the other way
 * round: by the lines that do the work and were left out of the changed hunks (FeedGen run 2026-10-23: the writer cited exactly those
 * and the check called the item unproven). The kind of item is read from the contract's text, never from the writer's.
 */
export const PLAN_FACT_FENCE = "plan-fact";

export const planFactRowSchema = z.object({
  item: z.number().int().min(1).max(200),
  status: z.enum(["done", "not_done"]),
  evidence: z.array(z.string().min(1).max(300)).max(8).optional(),
  why: z.string().max(400).optional(),
}).strict();
export type PlanFactRow = z.infer<typeof planFactRowSchema>;

/** The format the writer is told, once, in its brief (writer-task.ts) and in every continuing turn. */
export const PLAN_FACT_BRIEF_LINE = [
  "End your answer with the plan→fact table: a fenced block opened with ```plan-fact that holds a JSON array, one row per acceptance item in the contract's order (item 1 is the first):",
  '{"item":1,"status":"done","evidence":["src/a.ts:10-24","cmd:npm test"]}, or for an item you did not finish {"item":2,"status":"not_done","why":"<reason>"}.',
  "Evidence is a file you changed with the lines that do the work (path:first-last, or the path alone) or a verification command of the contract (cmd:<command>); for an item that says something stays unchanged, cite the lines that do that work and that you left as they were.",
  "Lane Pilot checks each entry against the diff and the check results, never your prose; a done row without evidence that holds counts as not done.",
].join(" ");

export type PlanFactTable =
  | { status: "ok"; rows: PlanFactRow[] }
  | { status: "missing" }
  | { status: "invalid"; reason: string };

/** The last fenced `plan-fact` block of the writer's answer, parsed and validated; the text around it is not read. */
export function parsePlanFact(answer: string): PlanFactTable {
  const blocks = [...answer.matchAll(/```[ \t]*plan-fact[^\n]*\n([\s\S]*?)```/gi)];
  const block = blocks.at(-1);
  if (!block) return { status: "missing" };
  let json: unknown;
  try { json = JSON.parse(block[1]!); } catch (cause) { return { status: "invalid", reason: `the block is not JSON (${cause instanceof Error ? cause.message : "parse error"})`.slice(0, 200) }; }
  const parsed = z.array(planFactRowSchema).min(1).max(200).safeParse(json);
  if (!parsed.success) return { status: "invalid", reason: parsed.error.issues.slice(0, 2).map((issue) => `${issue.path.join(".") || "table"}: ${issue.message}`).join("; ").slice(0, 300) };
  const seen = new Set<number>();
  for (const row of parsed.data) {
    if (seen.has(row.item)) return { status: "invalid", reason: `item ${row.item} appears twice` };
    seen.add(row.item);
  }
  return { status: "ok", rows: parsed.data };
}

/** What the code knows of the candidate; nothing in it comes from the writer's text. */
export type PlanFactFacts = {
  /** Paths the candidate changed, relative to the workspace. */
  produced: readonly string[];
  /** Changed line ranges (1-based, inclusive) of each changed path; `all`: a new file, every line is new. A path missing here has no known hunks. */
  changed: Readonly<Record<string, ReadonlyArray<readonly [number, number]> | "all">>;
  /** Line counts of the files in `all`. */
  lineCount: Readonly<Record<string, number>>;
  /** Whether each cited file the candidate did not change exists in the repository. Absent when the repository could not be read: a file the item says stays as it was is then not shown to exist. */
  exists?: Readonly<Record<string, boolean>>;
  /** False when the diff against the task's base could not be read: line ranges are then not checked, and the report says so. */
  hunksKnown: boolean;
  /** The contract's `verification[].command` values. */
  contractCommands: readonly string[];
  /** The checks that ran for the candidate. */
  ran: ReadonlyArray<{ command: string; exitCode: number }>;
  /** The workspace root, stripped from absolute paths in the evidence. */
  root?: string;
};

export type FindingSeverity = "blocking" | "warning" | "info";
export type EvidenceCheck = { evidence: string; kind: "file" | "command" | "unparsed"; ok: boolean; code: string; note: string };
export type ItemVerdict = {
  item: number; acceptance: string;
  claimed: "done" | "not_done" | "none";
  verdict: "proven" | "unproven" | "declared_not_done" | "no_row";
  severity: FindingSeverity | "ok";
  evidence: EvidenceCheck[];
  why: string | null;
};
export type PlanFactCheck = {
  table: PlanFactTable["status"];
  tableReason: string | null;
  items: ItemVerdict[];
  /** Rows naming an item the contract does not have. */
  extraRows: number[];
  /** Items whose verdict blocks them. */
  blocking: number[];
  /** What the check could not look at; «not checked» is not «found nothing». */
  notChecked: string[];
  /** The declared wires of the contract, hop by hop (src/rooms/wires); absent when the contract declares none. */
  wires?: WireResult[];
};

/** Kinds of task that cite no changed code (a note, a finding, a check run): a missing plan-fact table is not a hole in their proof. */
export const NO_CODE_KINDS: ReadonlySet<string> = new Set(["docs", "research", "check"]);

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

/** An acceptance item that claims something stays as it was; its proof is code the candidate did not change. */
// «Stays centred … as now», «remains», «keeps its margins» say the same thing (live ph_26f65b142d: «Bar stays horizontally centred with
// 12 pt side margins as now» was read as new work, and the untouched test that proves it as «not among the changed files»).
export const INVARIANT_ITEM = /\b(unchanged|not changed|untouched|stays? the same|still (?:works?|returns?|passes|serves?)|no (?:other )?changes?|as (?:now|before|today|it (?:is|was))|remains? (?:as|the same|unchanged))\b|не (?:меня|трога|измен)|без изменений|по-прежнему|как раньше|как сейчас/i;
const relativePath = (path: string, root?: string) => {
  let clean = path.trim().replace(/^\.\//, "");
  if (root && clean.startsWith(`${root.replace(/\/$/, "")}/`)) clean = clean.slice(root.replace(/\/$/, "").length + 1);
  return clean;
};

function checkEvidence(evidence: string, facts: PlanFactFacts, invariant = false): EvidenceCheck {
  const raw = evidence.trim();
  if (/^cmd:/i.test(raw)) {
    const command = normalize(raw.slice(4));
    // A writer that shortens a long contract command with «...» names it by its start: one contract command must begin with it.
    const cut = /\s*(?:\.\.\.|…)/.exec(command);
    const head = cut && cut.index >= 20 ? command.slice(0, cut.index) : null;
    const byHead = head ? facts.contractCommands.filter((candidate) => normalize(candidate).startsWith(head)) : [];
    const contract = facts.contractCommands.find((candidate) => normalize(candidate) === command) ?? (byHead.length === 1 ? byHead[0] : undefined);
    const ranCommand = contract ? normalize(contract) : command;
    if (!contract) return { evidence, kind: "command", ok: false, code: "command_not_in_contract", note: "not a verification command of the contract" };
    const ran = facts.ran.find((check) => normalize(check.command) === ranCommand);
    if (!ran) return { evidence, kind: "command", ok: false, code: "command_not_run", note: "the contract lists it, but no result for it came back" };
    return ran.exitCode === 0
      ? { evidence, kind: "command", ok: true, code: "command_passed", note: "ran, exit code 0" }
      : { evidence, kind: "command", ok: false, code: "command_failed", note: `ran, exit code ${ran.exitCode}` };
  }
  const match = /^(.+?)(?::(\d+)(?:-(\d+))?)?$/.exec(raw);
  if (!match || /\s/.test(match[1]!)) return { evidence, kind: "unparsed", ok: false, code: "unparsed", note: "neither path[:lines] nor cmd:<command>" };
  const path = relativePath(match[1]!, facts.root);
  if (!facts.produced.includes(path)) {
    if (!invariant) return { evidence, kind: "file", ok: false, code: "file_not_in_diff", note: `${path} is not among the changed files` };
    // A path that is nowhere in the repository is not code that stays as it was: it proves nothing.
    if (facts.exists && facts.exists[path] !== true) return { evidence, kind: "file", ok: false, code: "file_missing", note: `${path} is not among the changed files and does not exist in the repository` };
    return { evidence, kind: "file", ok: true, code: "file_untouched", note: `${path} is not among the changed files, as the item says` };
  }
  if (match[2] === undefined) return { evidence, kind: "file", ok: true, code: "file_changed", note: "among the changed files" };
  const from = Number(match[2]);
  const to = match[3] === undefined ? from : Number(match[3]);
  if (from < 1 || to < from) return { evidence, kind: "file", ok: false, code: "lines_invalid", note: `lines ${from}-${to} are not a range` };
  if (!facts.hunksKnown) return { evidence, kind: "file", ok: true, code: "lines_unchecked", note: "file changed; the lines could not be compared with a diff" };
  const known = facts.changed[path];
  if (known === undefined) return { evidence, kind: "file", ok: true, code: "lines_unchecked", note: "file changed; its hunks are unknown" };
  if (known === "all") {
    const count = facts.lineCount[path];
    return count !== undefined && from > count
      ? { evidence, kind: "file", ok: false, code: "lines_missing", note: `${path} has ${count} lines` }
      : { evidence, kind: "file", ok: true, code: "lines_changed", note: "new file" };
  }
  if (known.some(([a, b]) => from <= b && to >= a)) return { evidence, kind: "file", ok: true, code: "lines_changed", note: "overlaps a changed hunk" };
  return invariant
    ? { evidence, kind: "file", ok: true, code: "lines_kept", note: `lines ${from}-${to} of ${path} are left out of the changed hunks, as the item says` }
    : { evidence, kind: "file", ok: false, code: "lines_not_changed", note: `lines ${from}-${to} of ${path} are not in a changed hunk` };
}

/** The blind check: the table against the candidate, item by item. */
export function blindPlanFact(acceptance: readonly string[], table: PlanFactTable, facts: PlanFactFacts): PlanFactCheck {
  const notChecked: string[] = [];
  if (table.status !== "ok") {
    return { table: table.status, tableReason: table.status === "invalid" ? table.reason : null, items: [], extraRows: [], blocking: [],
      notChecked: ["every acceptance item: the writer gave no readable plan-fact table"] };
  }
  if (!facts.hunksKnown) notChecked.push("line ranges: the diff against the task's base could not be read, so only the files were checked");
  const byItem = new Map(table.rows.map((row) => [row.item, row]));
  const items: ItemVerdict[] = acceptance.map((text, index) => {
    const row = byItem.get(index + 1);
    if (!row) return { item: index + 1, acceptance: text, claimed: "none", verdict: "no_row", severity: "blocking", evidence: [], why: null };
    if (row.status === "not_done") return { item: index + 1, acceptance: text, claimed: "not_done", verdict: "declared_not_done", severity: "blocking", evidence: [], why: row.why ?? null };
    const evidence = (row.evidence ?? []).map((entry) => checkEvidence(entry, facts, INVARIANT_ITEM.test(text)));
    const proven = evidence.some((entry) => entry.ok);
    // A file the item says is untouched cannot be shown to exist from the diff alone: proven, but as a warning.
    const soft = evidence.some((entry) => entry.ok && (entry.code === "lines_unchecked" || entry.code === "file_untouched"));
    return { item: index + 1, acceptance: text, claimed: "done", verdict: proven ? "proven" : "unproven",
      severity: proven ? (evidence.some((entry) => !entry.ok) || soft ? "warning" : "ok") : "blocking", evidence, why: row.why ?? null };
  });
  return {
    table: "ok", tableReason: null, items,
    extraRows: table.rows.filter((row) => row.item > acceptance.length).map((row) => row.item),
    blocking: items.filter((item) => item.severity === "blocking").map((item) => item.item),
    notChecked,
  };
}

/** The stage result the code decides from the check: a missing or unreadable table is not run (a refusal only when the gate requires the table). */
export function planFactOutcome(check: PlanFactCheck, tableRequired = false): { state: "passed" | "failed" | "skipped"; reason: string | null } {
  // A broken wire is a code fact about the finished work, whatever the writer's table says.
  const wire = brokenWireReason(check.wires ?? []);
  if (wire) return { state: "failed", reason: wire };
  // `tableRequired` (gate mode, a code task with acceptance items): no readable table leaves every item unchecked, which is not a pass.
  const without = tableRequired ? "failed" : "skipped";
  if (check.table === "missing") return { state: without, reason: `plan_fact_table_missing: the writer's answer has no plan-fact block, so no acceptance item was checked against the diff${tableRequired ? "; end the answer with the plan-fact table" : ""}` };
  if (check.table === "invalid") return { state: without, reason: `plan_fact_table_invalid: ${check.tableReason ?? "unreadable"}; no acceptance item was checked against the diff${tableRequired ? "; fix the plan-fact table" : ""}` };
  if (check.blocking.length) return { state: "failed", reason: `plan_fact_unproven: acceptance item ${check.blocking.join(", ")} ${check.blocking.length === 1 ? "has" : "have"} no evidence that holds in the diff` };
  return { state: "passed", reason: null };
}

/** Changed line ranges per path from `git diff -U0` lines (`+++ b/path` and `@@ -a,b +c,d @@`); only those two kinds of line are read. */
export function parseDiffHunks(output: string): Record<string, Array<[number, number]>> {
  const out: Record<string, Array<[number, number]>> = {};
  let path: string | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("+++ ")) {
      const name = line.slice(4).trim();
      path = name === "/dev/null" ? null : name.replace(/^b\//, "");
      if (path) out[path] ??= [];
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && path) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      // A pure deletion leaves no new line: the line it sits at counts as changed.
      out[path]!.push([start, count === 0 ? start : start + count - 1]);
    }
  }
  return out;
}

const quote = (path: string) => `'${path.replace(/'/g, `'\\''`)}'`;
export const PLAN_FACT_UNTRACKED_MARK = "---untracked---";
export const PLAN_FACT_NO_BASE_MARK = "---nobase---";

/** One shell command that prints the hunk headers against the base commit, then the untracked files among the paths. */
export function diffHunksCommand(baseSha: string, paths: readonly string[]): string {
  const list = paths.map(quote).join(" ");
  return `git cat-file -e ${baseSha}^{commit} 2>/dev/null || echo ${PLAN_FACT_NO_BASE_MARK}; `
    + `git -c core.quotepath=off diff -U0 --no-color --no-ext-diff ${baseSha} -- ${list} | grep -E '^(\\+\\+\\+ |@@ )'; `
    + `echo ${PLAN_FACT_UNTRACKED_MARK}; git ls-files --others --exclude-standard -- ${list}`;
}

/** The facts the diff command's output gives: hunks of tracked paths, `all` for untracked ones. */
export function hunksFromCommandOutput(output: string, produced: readonly string[]): { hunksKnown: boolean; changed: Record<string, Array<[number, number]> | "all"> } {
  if (output.includes(PLAN_FACT_NO_BASE_MARK)) return { hunksKnown: false, changed: {} };
  const [tracked = "", untracked = ""] = output.split(PLAN_FACT_UNTRACKED_MARK);
  const hunks = parseDiffHunks(tracked);
  const changed: Record<string, Array<[number, number]> | "all"> = {};
  for (const path of produced) if (hunks[path]?.length) changed[path] = hunks[path]!;
  for (const line of untracked.split("\n")) {
    const path = line.trim();
    if (path && produced.includes(path)) changed[path] = "all";
  }
  return { hunksKnown: true, changed };
}

/** The files the table cites that the candidate did not change: whether they exist is a fact the stage reads from the repository. */
export function untouchedCitations(rows: readonly PlanFactRow[], produced: readonly string[], root?: string): string[] {
  const out = new Set<string>();
  for (const row of rows) for (const entry of row.evidence ?? []) {
    const raw = entry.trim();
    const match = /^(.+?)(?::(\d+)(?:-(\d+))?)?$/.exec(raw);
    if (/^cmd:/i.test(raw) || !match || /\s/.test(match[1]!)) continue;
    const path = relativePath(match[1]!, root);
    if (!produced.includes(path)) out.add(path);
  }
  return [...out].slice(0, 40);
}

/** One shell command that prints `yes <path>` or `no <path>` for each file; a path that leaves the repository is `no`. */
export function existsCommand(paths: readonly string[]): string {
  return paths.map((path) => /(^|\/)\.\.(\/|$)|^\//.test(path) ? `echo no ${quote(path)}` : `if [ -f ${quote(path)} ]; then echo yes ${quote(path)}; else echo no ${quote(path)}; fi`).join("; ");
}

/** The existence facts the command's output gives; a path the output does not name does not exist. */
export function existsFromCommandOutput(output: string, paths: readonly string[]): Record<string, boolean> {
  const yes = new Set(output.split("\n").filter((line) => line.startsWith("yes ")).map((line) => line.slice(4).trim()));
  return Object.fromEntries(paths.map((path) => [path, yes.has(path)]));
}

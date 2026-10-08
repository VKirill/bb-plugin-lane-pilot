import { settleVerdict } from "./verdict";
import type { Verdict, VerdictFinding } from "./verdict";
import type { NodeExecutor, StepContext } from "./engine";

/**
 * The actions of the chains that are code and nothing else: no model reads a list, counts findings or decides what a check
 * means. Each takes the references the node names in `reads` (and its params) and returns the declared fields. Actions that
 * need the plugin's database, the host or a helper thread are in `src/server/workflow-executors.ts`.
 */
type Row = Record<string, unknown>;
const rec = (value: unknown): Row => (typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

type Reader = (index: number) => unknown;
type PureAction = (input: { node: StepContext["node"]; params: Row; read: Reader; ctx: StepContext }) => { output: Row; detail?: unknown };

const SEVERITY_RANK: Record<string, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };
const words = (text: string): Set<string> => new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 2));
const overlap = (a: string, b: string): number => {
  const left = words(a), right = words(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.min(left.size, right.size);
};
const normalizeText = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim();
const normalizeUrl = (url: string): string => url.trim().toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "");
const ENGAGEMENT = ["engagement", "likes", "replies", "reposts", "quotes", "comments", "score"];
const engagementOf = (item: Row): number => ENGAGEMENT.reduce((sum, field) => sum + num(item[field]), 0);

/** items.dedupe: posts by url or normalized text (the one with more engagement stays, a bare repost goes), findings by file and place or overlapping text (the higher severity stays). */
const dedupe: PureAction = ({ node, read }) => {
  const input = list(read(0));
  const outName = (node as { out?: Array<{ name: string }> }).out?.[0]?.name ?? "items";
  if (outName === "findings") {
    const kept: Row[] = [];
    let merged = 0;
    for (const raw of input) {
      const finding = rec(raw);
      const text = str(finding.description) || str(finding.evidence) || str(finding.finding);
      const same = kept.find((other) => str(other.file) === str(finding.file) && ((finding.line != null && other.line === finding.line) || overlap(str(other.description) || str(other.evidence) || str(other.finding), text) > 0.8));
      if (!same) { kept.push({ ...finding }); continue; }
      merged += 1;
      if ((SEVERITY_RANK[str(finding.severity)] ?? 0) > (SEVERITY_RANK[str(same.severity)] ?? 0)) Object.assign(same, finding);
    }
    return { output: { findings: kept, merged } };
  }
  const byKey = new Map<string, Row>();
  for (const raw of input) {
    const item = rec(raw);
    const text = normalizeText(str(item.text));
    if ((item.is_repost === true || item.repost === true || item.type === "repost") && !text) continue;
    const key = str(item.url) ? `u:${normalizeUrl(str(item.url))}` : `t:${text}`;
    const textKey = text ? `t:${text}` : "";
    const known = byKey.get(key) ?? (textKey ? byKey.get(textKey) : undefined);
    if (!known) { byKey.set(key, item); if (textKey && textKey !== key) byKey.set(textKey, item); continue; }
    if (engagementOf(item) > engagementOf(known)) { for (const [mapKey, value] of byKey) if (value === known) byKey.set(mapKey, item); }
  }
  const items = [...new Set(byKey.values())];
  return { output: { items, count: items.length } };
};

/** dag.validate: sessions with `id` and `depends_on`; unknown or duplicate ids, cycles, and requirements that map to no session or to more than one. */
const dagValidate: PureAction = ({ read }) => {
  const sessions = list(read(0)).map(rec);
  const errors: string[] = [], cycles: string[] = [];
  const ids = sessions.map((session) => str(session.id));
  for (const [at, id] of ids.entries()) {
    if (!id) errors.push(`session #${at + 1} has no id`);
    else if (ids.indexOf(id) !== at) errors.push(`duplicate session id ${id}`);
  }
  const graph = new Map(sessions.map((session) => [str(session.id), list(session.depends_on).map(String)]));
  for (const [id, deps] of graph) for (const dep of deps) if (!graph.has(dep)) errors.push(`${id} depends on unknown session ${dep}`);
  const state = new Map<string, "open" | "done">();
  const walk = (id: string, trail: string[]): void => {
    if (state.get(id) === "done" || !graph.has(id)) return;
    if (state.get(id) === "open") { cycles.push([...trail.slice(trail.indexOf(id)), id].join(">")); return; }
    state.set(id, "open");
    for (const dep of graph.get(id)!) walk(dep, [...trail, id]);
    state.set(id, "done");
  };
  for (const id of graph.keys()) walk(id, []);
  const map = read(1);
  const pairs: Array<[string, string[]]> = Array.isArray(map)
    ? map.map((row) => [str(rec(row).requirement) || str(rec(row).id), list(rec(row).sessions ?? rec(row).session).map(String)] as [string, string[]])
    : Object.entries(rec(map)).map(([requirement, value]) => [requirement, (Array.isArray(value) ? value : [value]).filter((item) => item != null && item !== "").map(String)] as [string, string[]]);
  for (const [requirement, mapped] of pairs) {
    if (mapped.length === 0) errors.push(`requirement ${requirement} maps to no session`);
    else if (mapped.length > 1) errors.push(`requirement ${requirement} maps to ${mapped.length} sessions (${mapped.join(", ")}); each maps to exactly one`);
    for (const id of mapped) if (!graph.has(id)) errors.push(`requirement ${requirement} maps to unknown session ${id}`);
  }
  return { output: { ok: errors.length === 0 && cycles.length === 0, errors, cycles } };
};

const SECRETS: Array<[string, RegExp]> = [
  ["api_key", /\bsk-[A-Za-z0-9_-]{20,}/], ["aws_key", /\bAKIA[0-9A-Z]{16}\b/], ["github_token", /\bgh[pousr]_[A-Za-z0-9]{30,}/], ["slack_token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ["bearer", /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/], ["private_key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["session_cookie", /\b(auth_token|ct0|sessionid|session_id|cookie)\s*[=:]\s*[A-Za-z0-9%._-]{16,}/i],
];
const MESSAGE_LIMIT = 4096;
const PART_SIZE = 3800;

/** digest.check: a quote is a substring of an item, a cited URL is an item's, no secret-like string, the length fits Telegram messages (or splits into parts). */
const digestCheck: PureAction = ({ read }) => {
  const text = str(read(0));
  const items = list(read(1)).map(rec);
  const violations: string[] = [];
  if (!text.trim()) violations.push("empty_digest");
  const haystack = items.map((item) => normalizeText(str(item.text)));
  const quotes = [...text.matchAll(/«([^»\n]{8,})»|“([^”\n]{8,})”|"([^"\n]{12,})"|^>\s*(.{8,})$/gm)].map((match) => (match[1] ?? match[2] ?? match[3] ?? match[4] ?? "").trim());
  for (const quote of quotes) {
    // An ellipsis cuts a quote into pieces; each piece must be there.
    const pieces = quote.split(/…|\.\.\./).map(normalizeText).filter((piece) => piece.length >= 6);
    if (pieces.some((piece) => !haystack.some((body) => body.includes(piece)))) violations.push(`quote_not_found:${quote.slice(0, 60)}`);
  }
  const known = new Set(items.flatMap((item) => [str(item.url), ...list(item.links).map(String)]).filter(Boolean).map(normalizeUrl));
  for (const match of text.matchAll(/https?:\/\/[^\s)>\]"'«»]+/g)) {
    const url = match[0].replace(/[.,;:!?]+$/, "");
    if (!known.has(normalizeUrl(url))) violations.push(`url_unknown:${url.slice(0, 80)}`);
  }
  for (const [kind, pattern] of SECRETS) if (pattern.test(text)) violations.push(`secret_like:${kind}`);
  const parts = Math.max(1, text.length <= MESSAGE_LIMIT ? 1 : Math.ceil(text.length / PART_SIZE));
  if (parts > 8) violations.push(`too_long:${text.length}`);
  return { output: { ok: violations.length === 0, violations: [...new Set(violations)], parts } };
};

/** citations.check: every [n] names a listed source and every listed source is cited. (The HTTP status of the links is a separate step: it needs the network.) */
const citationsCheck: PureAction = ({ read }) => {
  const text = str(read(0));
  const sources = list(read(1)).map(rec);
  const cited = new Set<number>();
  const broken: string[] = [];
  for (const match of text.matchAll(/\[(\d{1,3})\](?!\()/g)) {
    const at = Number(match[1]);
    if (at < 1 || at > sources.length) { if (!broken.includes(`[${at}]`)) broken.push(`[${at}]`); } else cited.add(at);
  }
  const unresolved = sources.map((source, index) => [index + 1, source] as const).filter(([at]) => !cited.has(at)).map(([at, source]) => `[${at}] ${str(source.url) || str(source.title)}`.trim());
  return { output: { citation_ok: broken.length === 0 && unresolved.length === 0 && (sources.length === 0 || cited.size > 0), broken, unresolved } };
};

/**
 * verdict.aggregate (lp.review): the status by thresholds, never by a model. A critical or high finding that names no file and
 * line or quotes no evidence counts as medium (settleVerdict); findings the majority check dropped are gone; critical >= 1,
 * high > 5 or an unmet criterion send the work back (rework); 1 to 5 high is a pass with a warning; a dimension that could
 * not run, with nothing to fix, blocks (the PM is told the review is incomplete).
 */
const aggregate: PureAction = ({ read }) => {
  const dropped = new Set(list(read(1)).map(String));
  const unchecked = list(read(2)).map(String);
  const unmet = num(read(3));
  const candidates = list(read(0)).map(rec).filter((finding) => !dropped.has(str(finding.id)));
  const asVerdict: Verdict = { status: "pass", evidence: "aggregate", findings: candidates.map((finding) => ({ ...finding, file: str(finding.file), severity: (str(finding.severity) in SEVERITY_RANK ? str(finding.severity) : "info"), evidence: str(finding.evidence) }) as VerdictFinding) };
  const findings = settleVerdict(asVerdict, "code").verdict.findings;
  const critical = findings.filter((finding) => finding.severity === "critical").length;
  const high = findings.filter((finding) => finding.severity === "high").length;
  const remaining = critical + high;
  const rework = critical >= 1 || high > 5 || unmet >= 1;
  const status = rework ? "rework" : unchecked.length ? "block" : "pass";
  const warn = status === "pass" && high >= 1;
  const summary = status === "block" ? `The review is incomplete: ${unchecked.join(", ")} could not be checked.`
    : status === "rework" ? `${critical} critical, ${high} high findings${unmet ? `, ${unmet} unmet criteria` : ""}; the work goes back.`
    : warn ? `${high} high finding(s) to look at, none blocking.` : "No findings that block.";
  const verdict: Verdict = { status, summary, findings, evidence: `thresholds: critical>=1 or high>5 or unmet>=1 -> rework; unchecked dimensions: ${unchecked.length}` };
  return { output: { status, warn, critical_count: critical, high_count: high, remaining_actionable: remaining, findings, verdict } };
};

/** lp.propose_workflow: the terminal «offer to start workflow X with inputs Y». The decision to run it is the policy's and the owner's; the offer is in the receipt and the run output. */
const propose: PureAction = ({ node, ctx }) => {
  const params = (node as { params?: Row }).params ?? {};
  const workflow = str(params.workflow);
  return { output: {}, detail: { proposed: workflow, inputs: ctx.template(params.inputs ?? {}) } };
};

const ACTIONS: Record<string, { run: PureAction }> = {
  "items.dedupe": { run: dedupe }, "dag.validate": { run: dagValidate }, "digest.check": { run: digestCheck }, "citations.check": { run: citationsCheck },
  "verdict.aggregate": { run: aggregate }, "lp.propose_workflow": { run: propose },
};
/** The inputs verdict.aggregate reads, whatever the node lists. */
const AGGREGATE_READS = ["dims.findings", "confirm.dropped_ids", "dims.unchecked", "spec_check.unmet_count"];

export const PURE_ACTION_KEYS = Object.keys(ACTIONS);

export function pureActionExecutor(key: string): NodeExecutor {
  const action = ACTIONS[key]!;
  return { reentrant: true, run: async (ctx) => {
    const node = ctx.node as StepContext["node"] & { reads?: string[]; params?: Row };
    const refs = key === "verdict.aggregate" ? AGGREGATE_READS : node.reads ?? [];
    const result = action.run({ node, params: node.params ?? {}, read: (index) => (refs[index] === undefined ? undefined : ctx.resolve(refs[index]!)), ctx });
    return { output: result.output, ...(result.detail !== undefined ? { detail: result.detail } : {}) };
  } };
}

/** Registers the code-only actions on an engine. */
export function registerPureActions(engine: { register(key: string, executor: NodeExecutor): unknown }): void {
  for (const key of PURE_ACTION_KEYS) engine.register(key, pureActionExecutor(key));
}

import { CREDENTIAL_SHAPE_PATTERNS, redactKnown } from "@lane-pilot/kit";
import { FORBIDDEN_GRANTS } from "../forge";

export type DeprojectizeFindingCode = "abs_path" | "project_id" | "host_id" | "project_name_or_domain" | "secret_shape" | "forbidden_grant";
export type DeprojectizeFinding = { readonly code: DeprojectizeFindingCode; readonly path: string; readonly detail: string };
export type DeprojectizeLogLevel = "debug" | "info" | "warn" | "error" | "silent";
export type DeprojectizeContext = {
  readonly knownProjectIds?: readonly string[];
  readonly knownProjectNames?: readonly string[];
  readonly knownDomains?: readonly string[];
  readonly knownHostIds?: readonly string[];
  readonly log?: (message: string) => void;
  readonly logLevel?: DeprojectizeLogLevel;
};
export type DeprojectizeVerdict = { readonly ok: boolean; readonly workflowId: string; readonly findings: DeprojectizeFinding[] };
export type EvolutionDiffKind = "minor_patch" | "structural_or_new";
export type EvolutionDiffClassification = {
  readonly kind: EvolutionDiffKind;
  readonly workflowId: string;
  readonly reasons: string[];
  readonly addedSkills: string[];
  readonly addedInputs: string[];
};

const LOG_RANK: Readonly<Record<DeprojectizeLogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const ABS_PATH_RE = /(?:^|[\s"'`(=:])((?:\/Users\/|\/home\/|\/var\/folders\/|\/private\/tmp\/)[^\s"'`)]+|[A-Za-z]:\\[^\s"'`)]+)/;
const PROJ_ID_RE = /\bproj_[a-z0-9]{6,}\b/i;
const HOST_ID_RE = /\bhost_[a-z0-9]{6,}\b/i;
const TELEGRAM_BOT_TOKEN_RE = /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/;
const LITERAL_DOMAIN_RE = /\b(?:[a-z0-9-]+\.)+(?:ru|su|рф|com|net|org|io|ai|app|dev|co|me|info|biz|pro|tech|online|site|store|shop|cloud|uk|de|fr|es|it|nl|pl|ua|by|kz)\b/gi;
const GENERIC_DOMAINS = new Set(["example.com", "example.org", "example.net", "example.ru", "localhost", "127.0.0.1"]);
const INPUT_PLACEHOLDER_RE = /\{\{\s*\$?inputs\.[A-Za-z0-9_.-]+\s*\}\}|\$inputs\.[A-Za-z0-9_.-]+/g;
const STRUCTURAL_REASONS = new Set(["new_v1", "topology_nodes_changed", "topology_edges_changed", "permissions_expanded", "breaking_required_input", "skills_removed", "category_changed"]);

const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const testRe = (re: RegExp, text: string): boolean => { re.lastIndex = 0; return re.test(text); };
const asRecords = (v: unknown): Array<Record<string, unknown>> => Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => Boolean(x && typeof x === "object")) : [];
const asStrings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const normEnd = (v: unknown) => (v === "$start" ? "start" : v === "$end" ? "end" : String(v ?? ""));
const hasExtra = (base: readonly string[], next: readonly string[]): boolean => { const s = new Set(base); return next.some((item) => !s.has(item)); };

function emit(log: ((message: string) => void) | undefined, level: "debug" | "warn", event: string, payload: Record<string, unknown>, override?: DeprojectizeLogLevel): void {
  if (!log) return;
  const envRaw = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.LOG_LEVEL?.trim().toLowerCase() as DeprojectizeLogLevel | undefined;
  const effective = override ?? (envRaw && envRaw in LOG_RANK ? envRaw : "debug");
  if (LOG_RANK[level] < LOG_RANK[effective]) return;
  log(`${level.toUpperCase()} [nightGraphs.deprojectize] ${event} ${redactKnown(JSON.stringify(payload))}`);
}

function walkStrings(value: unknown, path: string, visit: (path: string, text: string) => void): void {
  if (typeof value === "string") { visit(path || "$", value); return; }
  if (Array.isArray(value)) { value.forEach((item, idx) => walkStrings(item, `${path}[${idx}]`, visit)); return; }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) walkStrings(item, path ? `${path}.${key}` : key, visit);
  }
}

function tokenMatch(text: string, values: readonly string[] | undefined, minLen: number, unicode: boolean): string | null {
  for (const raw of values ?? []) {
    const val = raw.trim();
    if (val.length < minLen || val === "*" || val.toLowerCase() === "global") continue;
    const re = unicode
      ? new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escapeRe(val)}(?=$|[^\\p{L}\\p{N}_])`, "iu")
      : new RegExp(`(?:^|[^A-Za-z0-9_-])${escapeRe(val)}(?=$|[^A-Za-z0-9_-])`, "i");
    if (re.test(text)) return val;
  }
  return null;
}

/** Ensures a global workflow definition has no hardcoded paths, project/host IDs, project domains, secrets, or forbidden grants. */
export function checkDeprojectization(definition: Record<string, unknown>, context: DeprojectizeContext = {}): DeprojectizeVerdict {
  const workflowId = typeof definition.id === "string" && definition.id.trim() ? definition.id.trim() : "unknown";
  const findings: DeprojectizeFinding[] = [];
  const push = (code: DeprojectizeFindingCode, path: string, detail: string) => findings.push({ code, path, detail });

  walkStrings(definition, "", (path, raw) => {
    const text = raw.replace(INPUT_PLACEHOLDER_RE, " ");
    const abs = ABS_PATH_RE.exec(text);
    if (abs) push("abs_path", path, `Hardcoded filesystem path "${abs[1]}" must be parameterized via $inputs.*`);
    const matchedProj = PROJ_ID_RE.test(text) ? "proj_*" : tokenMatch(text, context.knownProjectIds, 3, false);
    if (matchedProj) push("project_id", path, `Project ID "${matchedProj}" must be parameterized via $inputs.*`);
    const matchedHost = HOST_ID_RE.test(text) ? "host_*" : tokenMatch(text, context.knownHostIds, 3, false);
    if (matchedHost) push("host_id", path, `Host ID "${matchedHost}" must be parameterized via $inputs.*`);
    const matchedName = tokenMatch(text, context.knownProjectNames, 4, true) ?? tokenMatch(text, context.knownDomains, 4, false);
    if (matchedName) {
      push("project_name_or_domain", path, `Project reference "${matchedName}" must be parameterized via $inputs.*`);
    } else {
      LITERAL_DOMAIN_RE.lastIndex = 0;
      for (const m of text.matchAll(LITERAL_DOMAIN_RE)) {
        const dom = m[0].toLowerCase();
        if (!GENERIC_DOMAINS.has(dom) && !dom.endsWith(".example") && !dom.endsWith(".localhost")) {
          push("project_name_or_domain", path, `Literal domain "${dom}" must be parameterized via $inputs.*`);
          break;
        }
      }
    }
    if (CREDENTIAL_SHAPE_PATTERNS.some((pat) => testRe(pat, text)) || TELEGRAM_BOT_TOKEN_RE.test(text)) {
      push("secret_shape", path, "Credential-shaped token or key material is forbidden in global workflows");
    }
    for (const grant of FORBIDDEN_GRANTS) if (testRe(grant.pattern, text)) push("forbidden_grant", path, `Forbidden grant: ${grant.why}`);
  });

  if (findings.length > 0) emit(context.log, "warn", "rejected", { workflowId, count: findings.length, codes: [...new Set(findings.map((f) => f.code))] }, context.logLevel);
  else emit(context.log, "debug", "passed", { workflowId }, context.logLevel);
  return { ok: findings.length === 0, workflowId, findings };
}

function collectSkills(wf: Record<string, unknown>): Set<string> {
  const out = new Set<string>(asStrings((wf.requires as Record<string, unknown> | undefined)?.skills));
  for (const node of asRecords(wf.nodes)) {
    for (const s of asStrings((node.profile as Record<string, unknown> | undefined)?.skills)) out.add(s);
    for (const s of asStrings(node.skills)) out.add(s);
  }
  return out;
}

/** Classifies a workflow evolution as `minor_patch` (skills/copy/optional inputs) or `structural_or_new` (v1, topology, permissions, breaking inputs). */
export function classifyEvolutionDiff(
  baseWorkflow: Record<string, unknown> | null | undefined,
  nextWorkflow: Record<string, unknown>,
  options?: { log?: (message: string) => void; logLevel?: DeprojectizeLogLevel },
): EvolutionDiffClassification {
  const workflowId = (typeof nextWorkflow.id === "string" && nextWorkflow.id.trim())
    || (baseWorkflow && typeof baseWorkflow.id === "string" && baseWorkflow.id.trim()) || "unknown";
  if (!baseWorkflow) {
    const reasons = ["new_v1"];
    emit(options?.log, "debug", "diff", { workflowId, kind: "structural_or_new", reasons }, options?.logLevel);
    return { kind: "structural_or_new", workflowId, reasons, addedSkills: [], addedInputs: [] };
  }

  const reasons: string[] = [];
  const baseNodes = new Map(asRecords(baseWorkflow.nodes).map((n) => [String(n.id ?? ""), n]));
  const nextNodes = new Map(asRecords(nextWorkflow.nodes).map((n) => [String(n.id ?? ""), n]));
  const entryChanged = (typeof baseWorkflow.entry === "string" ? baseWorkflow.entry : null) !== (typeof nextWorkflow.entry === "string" ? nextWorkflow.entry : null);
  const nodesChanged = entryChanged || baseNodes.size !== nextNodes.size || [...baseNodes].some(([id, b]) => {
    const n = nextNodes.get(id);
    return !n || b.type !== n.type || (b.action ?? null) !== (n.action ?? null) || (b.role ?? null) !== (n.role ?? null) || (b.workflow ?? null) !== (n.workflow ?? null);
  });
  if (nodesChanged) reasons.push("topology_nodes_changed");

  const edgeKeys = (wf: Record<string, unknown>) => asRecords(wf.edges).map((e) => JSON.stringify([normEnd(e.from), normEnd(e.to), e.when ?? null])).sort();
  const baseEdges = edgeKeys(baseWorkflow);
  const nextEdges = edgeKeys(nextWorkflow);
  if (baseEdges.length !== nextEdges.length || baseEdges.some((k, i) => k !== nextEdges[i])) reasons.push("topology_edges_changed");

  const baseReq = (baseWorkflow.requires ?? {}) as Record<string, unknown>;
  const nextReq = (nextWorkflow.requires ?? {}) as Record<string, unknown>;
  const permExpanded = (["secrets", "plugins", "mcp"] as const).some((k) => hasExtra(asStrings(baseReq[k]), asStrings(nextReq[k])))
    || [...nextNodes].some(([id, n]) => {
      const b = baseNodes.get(id);
      return Boolean(b && ((Boolean(n.authorized) && !Boolean(b.authorized)) || hasExtra(asStrings(b.plugins), asStrings(n.plugins)) || hasExtra(asStrings(b.mcp), asStrings(n.mcp))));
    });
  if (permExpanded) reasons.push("permissions_expanded");

  const toInputMap = (inputsRaw: unknown): Map<string, { required: boolean }> => {
    const out = new Map<string, { required: boolean }>();
    if (Array.isArray(inputsRaw)) {
      for (const item of asRecords(inputsRaw)) {
        const name = String(item.name ?? "");
        if (name) out.set(name, { required: item.required !== false && item.default === undefined });
      }
    } else if (inputsRaw && typeof inputsRaw === "object") {
      for (const [name, spec] of Object.entries(inputsRaw as Record<string, unknown>)) {
        const rec = spec && typeof spec === "object" ? (spec as Record<string, unknown>) : null;
        out.set(name, { required: Boolean(rec && rec.required === true && rec.default === undefined) });
      }
    }
    return out;
  };
  const baseInputs = toInputMap(baseWorkflow.inputs);
  const addedInputs: string[] = [];
  for (const [name, inp] of toInputMap(nextWorkflow.inputs)) {
    const prev = baseInputs.get(name);
    if (!prev) {
      addedInputs.push(name);
      reasons.push(inp.required ? "breaking_required_input" : "optional_inputs_added");
    } else if (!prev.required && inp.required) {
      reasons.push("breaking_required_input");
    }
  }

  const baseSkills = collectSkills(baseWorkflow);
  const nextSkills = collectSkills(nextWorkflow);
  const addedSkills = [...nextSkills].filter((s) => !baseSkills.has(s));
  if (addedSkills.length > 0) reasons.push("skills_added");
  if ([...baseSkills].some((s) => !nextSkills.has(s))) reasons.push("skills_removed");
  const catIdOf = (wf: Record<string, unknown>): string | null =>
    typeof wf.category === "string" ? wf.category.trim() || null : (wf.category as { id?: string } | undefined)?.id?.trim() || null;
  if (catIdOf(baseWorkflow) !== catIdOf(nextWorkflow)) reasons.push("category_changed");

  const uniqueReasons = [...new Set(reasons)];
  if (!uniqueReasons.length && JSON.stringify(baseWorkflow) !== JSON.stringify(nextWorkflow)) uniqueReasons.push("copy_or_checks_refined");
  const kind: EvolutionDiffKind = uniqueReasons.some((r) => STRUCTURAL_REASONS.has(r)) ? "structural_or_new" : "minor_patch";
  emit(options?.log, "debug", "diff", { workflowId, kind, reasons: uniqueReasons }, options?.logLevel);
  return { kind, workflowId, reasons: uniqueReasons, addedSkills, addedInputs };
}

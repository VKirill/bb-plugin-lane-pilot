import { z } from "zod";
import { taskV2Schema } from "../../contracts";

/**
 * The registry of artifact kinds (W0). A step of a chain declares what it `produces` as `kind/version`; the engine and the
 * agent step check the output against the kind's schema at once, so a step whose answer has the wrong shape is not done
 * (the agent gets one repair turn that names the problems and shows the example). Each kind has a zod schema and an example
 * that the tests keep valid. Schemas check the shape the next step relies on (required keys, types), not the quality of the
 * content: they are open (`loose`), so a chain may carry more fields than the kind asks for.
 *
 * The shape of the artifacts follows Maestro-Flow's contract heads (`prepare/*.md`: consumes / produces / gates) and its
 * templates (`task.json`, `verification.json`); see THIRD_PARTY_NOTICES.md.
 */
export type ArtifactDef = {
  kind: string;
  version: number;
  title: string;
  /** The top-level keys the kind needs: a step that produces the whole output must declare these fields (the validator checks it). */
  required: readonly string[];
  schema: z.ZodType;
  example: unknown;
};

const text = z.string().trim().min(1);
const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
const STATUSES = ["pass", "rework", "block"] as const;

/** A finding names how serious it is and says what was seen (a title, a description or a quote). */
const finding = z.object({ severity: z.enum(SEVERITIES) }).loose().refine(
  (row) => ["title", "finding", "description", "evidence", "message", "summary"].some((key) => typeof row[key] === "string" && (row[key] as string).trim() !== ""),
  { message: "a finding needs a title, a description or quoted evidence" },
);
const findingExample = { severity: "high", file: "src/a.ts", line: 12, title: "the limit is not checked", evidence: "if (n > 0) return n;" };

const gap = z.object({
  id: text,
  type: z.enum(["must_have", "coverage", "anti_pattern", "uat"]),
  severity: z.enum(["critical", "high", "medium", "low"]),
  description: text,
  source: z.enum(["layer1", "layer2", "layer3", "nyquist", "uat"]),
  status: z.enum(["open", "planned", "fixed"]).default("open"),
}).loose();
const layerRow = z.object({ claim: text, ok: z.boolean() }).loose();

const defs: ArtifactDef[] = [
  {
    kind: "report", version: 1, title: "A step whose product is files or side effects: only the handoff is structured", required: ["handoff"],
    schema: z.object({ handoff: text }).loose(),
    example: { handoff: "Wrote .agents/seo/espresso/clusters.md (12 clusters); the briefs are left." },
  },
  {
    kind: "summary", version: 1, title: "A short summary of what was found or done", required: ["summary"],
    schema: z.object({ summary: z.string() }).loose(),
    example: { summary: "The module has three entry points; only `parse` is public." },
  },
  {
    kind: "plan", version: 1, title: "A plan: the objective, the tasks and the waves they run in", required: ["objective", "tasks"],
    schema: z.object({
      objective: text,
      tasks: z.array(z.object({ id: text }).loose()),
      waves: z.array(z.array(text)).optional(),
    }).loose(),
    example: { objective: "Rate-limit the export endpoint", tasks: [{ id: "T1", title: "Add the limiter", owns_paths: ["src/export/**"] }], waves: [["T1"]] },
  },
  {
    kind: "task", version: 2, title: "One writer task: the task-v2 contract (see lane-stack/schemas/task-v2.schema.json)",
    required: ["schema_version", "id", "title", "risk", "lane", "project_cwd", "read_first", "interfaces", "invariants", "out_of_scope", "expected_outputs", "owns_paths", "never_touch", "depends_on", "objective", "acceptance", "verify", "verification"],
    schema: taskV2Schema,
    example: {
      schema_version: 2, id: "T1", title: "Add the limiter", risk: "medium", lane: "writer", project_cwd: "/work/project",
      read_first: ["src/export/handler.ts:1-60"], interfaces: [], invariants: ["The response shape does not change."], out_of_scope: ["The import endpoint."],
      expected_outputs: ["src/export/limiter.ts"], owns_paths: ["src/export/**", "tests/export/**"], never_touch: [], depends_on: [],
      objective: "Reject the 11th export request of a minute with 429.",
      acceptance: ["`npx vitest run tests/export/limiter.test.ts` exits 0"],
      convergence: { criteria: ["src/export/limiter.ts contains 'RATE_LIMIT_PER_MINUTE = 10'", "`npx vitest run tests/export/limiter.test.ts` exits 0"] },
      files: [{ path: "src/export/limiter.ts", action: "create", change: "A sliding-window counter per user id; the limit is 10 per minute." }],
      verify: "tests", verification: [{ command: "npx vitest run tests/export/limiter.test.ts", cwd: "/work/project" }],
    },
  },
  {
    kind: "verdict", version: 1, title: "A judgement: pass, rework or block, with the findings behind it", required: ["status"],
    schema: z.object({ status: z.enum(STATUSES), summary: z.string().optional(), findings: z.array(finding).optional(), evidence: z.string().optional() }).loose(),
    example: { status: "rework", summary: "One acceptance line is not met.", findings: [findingExample], evidence: "Read src/a.ts and ran the tests." },
  },
  {
    kind: "findings", version: 1, title: "A list of findings, each with a severity and what was seen", required: ["findings"],
    schema: z.object({ findings: z.array(finding) }).loose(),
    example: { findings: [findingExample] },
  },
  {
    kind: "verification", version: 1, title: "A check of a result in three layers (exists, is real, is wired) and the gaps it found (Maestro verification.json)",
    required: ["status", "layer1_truths", "layer2_artifacts", "layer3_wiring", "gaps"],
    schema: z.object({
      status: z.enum(STATUSES),
      layer1_truths: z.array(layerRow),
      layer2_artifacts: z.array(layerRow),
      layer3_wiring: z.array(layerRow),
      anti_pattern_scan: z.object({ blockers: z.array(z.string()).default([]), warnings: z.array(z.string()).default([]) }).loose().optional(),
      gaps: z.array(gap),
    }).loose(),
    example: {
      status: "rework",
      layer1_truths: [{ claim: "src/export/limiter.ts exists", ok: true }],
      layer2_artifacts: [{ claim: "limiter.ts counts requests (not a stub)", ok: true }],
      layer3_wiring: [{ claim: "handler.ts calls the limiter", ok: false }],
      anti_pattern_scan: { blockers: [], warnings: ["TODO in src/export/limiter.ts:8"] },
      gaps: [{ id: "GAP-001", type: "must_have", severity: "high", description: "The limiter is not called by the handler.", source: "layer3", status: "open" }],
    },
  },
  {
    kind: "qa-report", version: 1, title: "A browser or UI check: the verdict, the findings and the screenshots", required: ["status", "findings"],
    schema: z.object({ status: z.enum(STATUSES), findings: z.array(finding), screenshots: z.array(z.string()).optional() }).loose(),
    example: { status: "pass", findings: [], screenshots: [".bb/chats/thr_x/qa/home-375.png"] },
  },
  {
    kind: "search-results", version: 1, title: "Sources found for a question", required: ["sources"],
    schema: z.object({ sources: z.array(z.object({ url: text }).loose()) }).loose(),
    example: { sources: [{ url: "https://example.com/report", title: "Market report 2026", snippet: "Demand grew 12% year on year." }] },
  },
  {
    kind: "analysis", version: 1, title: "An analysis: decisions, risks and a recommendation", required: ["recommendation"],
    schema: z.object({ recommendation: text, decisions: z.array(z.unknown()).optional(), risks: z.array(z.unknown()).optional(), confidence: z.number().optional() }).loose(),
    example: { recommendation: "go_with_conditions", decisions: [{ id: "D1", text: "Keep the old export format" }], risks: [{ id: "R1", text: "Large files time out" }], confidence: 80 },
  },
  {
    kind: "diagnosis", version: 1, title: "A root cause with the files it touches and the direction of the fix", required: ["root_cause", "affected_files"],
    schema: z.object({ root_cause: text, affected_files: z.array(z.string()), fix_direction: z.string().optional(), confidence: z.number().optional() }).loose(),
    example: { root_cause: "The last empty row of a CSV yields undefined.", affected_files: ["src/import/csv.ts:48"], fix_direction: "Skip empty trailing rows in parseCsv.", confidence: 82 },
  },
  {
    kind: "task-result", version: 1, title: "How a code task ended", required: ["state"],
    schema: z.object({ state: z.enum(["accepted", "failed", "blocked", "needs_human", "cancelled"]), merge_commit: z.string().optional(), files: z.array(z.string()).optional(), attempts: z.number().optional() }).loose(),
    example: { state: "accepted", merge_commit: "9d8558a", files: ["src/export/limiter.ts"], attempts: 1 },
  },
  {
    kind: "gate-decision", version: 1, title: "A stage of the task pipeline lets the task go on, or not", required: ["allowed"],
    schema: z.object({ allowed: z.boolean(), reason: z.string().optional() }).loose(),
    example: { allowed: false, reason: "T2 owns a path T1 also owns." },
  },
  {
    kind: "dispatch-reply", version: 1, title: "The answer the task pipeline gives the PM when a writer task is dispatched", required: ["reply"],
    schema: z.object({ reply: z.unknown() }).loose().refine((row) => "reply" in row, { message: "the reply is missing" }),
    example: { reply: { state: "queued", runId: "lprun_x", taskId: "T1" } },
  },
  {
    kind: "post-draft", version: 1, title: "The draft of a post and where it is", required: ["draft_path"],
    schema: z.object({ draft_path: text, claims_used: z.number().optional() }).loose(),
    example: { draft_path: ".agents/posts/espresso/draft.md", claims_used: 6 },
  },
  {
    kind: "invoice", version: 1, title: "An invoice that was made (or why it was not)", required: ["status"],
    schema: z.object({
      status: z.string().min(1), reason: z.string().optional(), invoice_number: z.string().optional(), invoice_date: z.string().optional(),
      invoice_url: z.string().optional(), pdf_path: z.string().optional(), client_name: z.string().optional(), client_inn: z.string().optional(),
    }).loose().refine((row) => row.status !== "done" || (Boolean(row.invoice_number?.trim()) && Boolean(row.pdf_path?.trim())), { message: "a done invoice needs invoice_number and pdf_path" }),
    example: { status: "done", invoice_number: "2026-114", invoice_date: "2026-10-08", invoice_url: "https://elba.kontur.ru/invoices/114", pdf_path: ".agents/invoices/2026-114.pdf", client_name: "OOO Roga", client_inn: "7701234567" },
  },
];

export const ARTIFACTS: readonly ArtifactDef[] = defs;

export const artifactId = (ref: { kind: string; version: number }): string => `${ref.kind}/${ref.version}`;

export function artifactDef(kind: string, version: number): ArtifactDef | undefined {
  return defs.find((def) => def.kind === kind && def.version === version);
}

/** `plan/1` to its kind and version; null when the text is not that shape. */
export function parseArtifactId(id: string): { kind: string; version: number } | null {
  const match = /^([a-z][a-z0-9-]{0,39})\/([1-9][0-9]{0,2})$/.exec(id.trim());
  return match ? { kind: match[1]!, version: Number(match[2]) } : null;
}

export type ArtifactCheck = { ok: true; value: unknown } | { ok: false; errors: string[] };

/** The value against the kind's schema; the errors name the path and say what is wrong (at most 8). */
export function validateArtifact(kind: string, version: number, value: unknown): ArtifactCheck {
  const def = artifactDef(kind, version);
  if (!def) return { ok: false, errors: [`unknown artifact kind ${kind}/${version}`] };
  const parsed = def.schema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  const errors = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
  return { ok: false, errors: errors.slice(0, 8) };
}

/** The example of a kind as text, for a repair turn and a start packet (clipped to `max` characters). */
export function artifactExample(kind: string, version: number, max = 900): string {
  const def = artifactDef(kind, version);
  if (!def) return "";
  const body = JSON.stringify(def.example);
  return body.length <= max ? body : `${body.slice(0, max)} ...`;
}

// ------------------------------------------------------------------ what a step declares

/** One entry of a node's `produces`: the output (or its field) is an artifact of this kind. */
export type ProducesSpec = { kind: string; version: number; required?: boolean; field?: string | undefined; each?: boolean | undefined };

/**
 * The problems of a step's output against what the step says it produces. An empty list means the output is a valid artifact
 * of every declared kind. A `field` names the output field that holds the artifact, `each` says that field is a list of them;
 * without `field` the whole output (its declared fields) is the artifact. An optional artifact that is absent is not a problem.
 */
export function checkProduces(produces: readonly ProducesSpec[], output: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const spec of produces) {
    const id = artifactId(spec);
    const present = spec.field === undefined ? true : output[spec.field] !== undefined && output[spec.field] !== null;
    if (!present) {
      if (spec.required !== false) problems.push(`${id}: the field "${spec.field}" is missing`);
      continue;
    }
    const subject = spec.field === undefined ? output : output[spec.field];
    const where = spec.field ?? "output";
    if (spec.each) {
      if (!Array.isArray(subject)) { problems.push(`${id}: "${where}" must be a list of ${id}`); continue; }
      subject.forEach((item, index) => {
        const result = validateArtifact(spec.kind, spec.version, item);
        if (!result.ok) problems.push(...result.errors.map((error) => `${id} ${where}[${index}]: ${error}`));
      });
      continue;
    }
    const result = validateArtifact(spec.kind, spec.version, subject);
    if (!result.ok) problems.push(...result.errors.map((error) => `${id} ${where}: ${error}`));
  }
  return problems.slice(0, 12);
}

// ------------------------------------------------------------------ summaries

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

/**
 * One or two lines that say what a value holds, for the reference that stands in for it in a start packet: a `summary` or
 * `handoff` text first, then the count of each list, then the short scalars. Never the whole value.
 */
export function summarizeValue(value: unknown, max = 220): string {
  if (typeof value === "string") return clip(oneLine(value), max);
  if (Array.isArray(value)) {
    const sample = value.slice(0, 3).map((item) => (typeof item === "string" ? item : typeof item === "object" && item !== null ? String((item as Record<string, unknown>).title ?? (item as Record<string, unknown>).id ?? (item as Record<string, unknown>).name ?? (item as Record<string, unknown>).url ?? "") : String(item))).filter(Boolean);
    return clip(`list of ${value.length}${sample.length ? `: ${sample.map((item) => clip(oneLine(item), 50)).join("; ")}${value.length > sample.length ? "; ..." : ""}` : ""}`, max);
  }
  if (typeof value !== "object" || value === null) return clip(String(value), max);
  const row = value as Record<string, unknown>;
  const lead = ["summary", "handoff", "objective", "root_cause", "recommendation"].map((key) => row[key]).find((entry) => typeof entry === "string" && entry.trim());
  const parts: string[] = [];
  if (typeof lead === "string") parts.push(clip(oneLine(lead), 120));
  for (const [key, entry] of Object.entries(row)) {
    if (parts.length >= 5) break;
    if (entry === lead) continue;
    if (Array.isArray(entry)) parts.push(`${key}: ${entry.length}`);
    else if (typeof entry === "string") { if (entry.length <= 40) parts.push(`${key}: ${oneLine(entry)}`); }
    else if (typeof entry === "number" || typeof entry === "boolean") parts.push(`${key}: ${entry}`);
  }
  return clip(parts.join("; ") || `object with ${Object.keys(row).length} keys`, max);
}

import type { Workflow } from "@lane-pilot/workflow-engine";
import { WORKFLOW_CATEGORIES, workflowCategory, type WorkflowCategory } from "./categories";

/** One workflow of the library with the text its file carries (the raw JSON object; builtins keep their bundled value). */
export type WorkflowExportEntry = {
  definition: Record<string, unknown>;
  workflow: Workflow;
  scope: "builtin" | "global" | "project";
};

export type WorkflowExportFile = { path: string; text: string };
export type WorkflowExportResult = {
  manifest: {
    lanePilotVersion: string;
    commit: string | null;
    exportedAt: string;
    redacted: boolean;
    graphs: Array<{ id: string; version: number; category: WorkflowCategory; scope: WorkflowExportEntry["scope"] }>;
  };
  files: WorkflowExportFile[];
  markdown: string;
};

/** Which entries of the library the export takes: `ids` the chosen ones, `category` one shelf, neither all. */
export function selectExportEntries(entries: WorkflowExportEntry[], selection: { ids?: string[]; category?: string; includeProjectGraphs?: boolean }): WorkflowExportEntry[] {
  const allowed = entries.filter((entry) => selection.includeProjectGraphs || entry.scope !== "project");
  if (selection.ids && selection.ids.length) { const wanted = new Set(selection.ids); return allowed.filter((entry) => wanted.has(entry.workflow.id)); }
  if (selection.category) return allowed.filter((entry) => workflowCategory(entry.workflow) === selection.category);
  return allowed;
}

const HOST_ID = /\bhost_[a-z0-9]+\b/g;
const SECRET_REF = /\{\{\s*secret:[^}\s]+\s*\}\}/g;
const HOME_PATH = /~(?:\/[\w.@+-]+)+/g;
// An absolute path is two or more `/segment` parts after a boundary; `https://host/a` cannot match (the char before the second `/` is `/`).
const ABS_PATH = /(^|[\s"'`(:=])(?:\/[\w.@+-]+){2,}/g;
const SECRET_NAME = /\bsecret:[A-Za-z_][A-Za-z0-9_]*\b/g;

const scrub = (text: string): string =>
  text.replace(HOST_ID, "<host>").replace(SECRET_REF, "<secret>").replace(SECRET_NAME, "<secret>").replace(HOME_PATH, "<path>").replace(ABS_PATH, "$1<path>");

/**
 * A copy of a workflow file's JSON with private values blanked: `requires.secrets` entries, `{{secret:NAME}}` and `secret:NAME`
 * references, host ids (`host_x`) and filesystem paths (`/a/b`, `~/x`). Runs on the raw definition, before it is stringified.
 */
export function redactDefinition(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactDefinition);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "secrets" && Array.isArray(item)) { out[key] = item.map((entry) => (typeof entry === "string" ? "<secret>" : redactDefinition(entry))); continue; }
      out[key] = redactDefinition(item);
    }
    return out;
  }
  return typeof value === "string" ? scrub(value) : value;
}

const nodeLine = (node: Workflow["nodes"][number], locale: "en" | "ru"): string => {
  const title = "title" in node && node.title ? node.title[locale] : node.id;
  const role = "role" in node && node.role ? `, ${node.role}` : "";
  return `  - ${title} — ${node.type}${role}`;
};

/** The human-readable overview of the export: a section per category, a block per graph, its steps in order. */
export function exportMarkdown(entries: WorkflowExportEntry[], locale: "en" | "ru" = "ru"): string {
  const lines: string[] = [locale === "ru" ? "# Графы Lane Pilot" : "# Lane Pilot graphs", ""];
  for (const category of WORKFLOW_CATEGORIES) {
    const group = entries.filter((entry) => workflowCategory(entry.workflow) === category);
    if (!group.length) continue;
    lines.push(`## ${category}`, "");
    for (const entry of group) {
      lines.push(`### ${entry.workflow.name[locale]} (\`${entry.workflow.id}\`)`, "", entry.workflow.description[locale], "", ...(entry.workflow.nodes.map((node) => nodeLine(node, locale))), "");
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** The whole export: the manifest, one `workflows/<id>.json` file per selected graph, and the markdown overview. */
export function buildWorkflowExport(input: {
  entries: WorkflowExportEntry[];
  ids?: string[];
  category?: string;
  includeProjectGraphs?: boolean;
  redact: boolean;
  version: string;
  commit: string | null;
  now?: Date;
}): WorkflowExportResult {
  const selected = selectExportEntries(input.entries, input);
  const exportedAt = (input.now ?? new Date()).toISOString();
  const files = selected.map((entry) => ({
    path: `workflows/${entry.workflow.id}.json`,
    text: `${JSON.stringify(input.redact ? redactDefinition(entry.definition) : entry.definition, null, 2)}\n`,
  }));
  return {
    manifest: {
      lanePilotVersion: input.version,
      commit: input.commit,
      exportedAt,
      redacted: input.redact,
      graphs: selected.map((entry) => ({ id: entry.workflow.id, version: entry.workflow.version, category: workflowCategory(entry.workflow), scope: entry.scope })),
    },
    files,
    markdown: exportMarkdown(selected),
  };
}

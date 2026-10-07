import { CONDITION_OPS, FIELD_TYPES, PASS_MODES, QUALITY_MODES } from "./schema";

/**
 * What the architect may use in a chain, collected from the machine the owner works on: skills, BB plugins, MCP servers,
 * Env Catalog names (never values), machines, the browser. A source that cannot be asked is reported as such instead of
 * as an empty list, because «no skills» and «could not read the skills» call for different advice.
 */
export type Section<T> = { status: "ready" | "unavailable" | "error"; items: T[]; error?: string; total?: number };

export type CapabilityPorts = {
  skills?: () => Promise<Array<{ name: string; description?: string; pluginId?: string | null }>>;
  plugins?: () => Promise<Array<{ id: string; name: string }>>;
  mcpServers?: () => Promise<Array<{ name: string; sources?: string[] }>>;
  /** Env Catalog entries by name and kind; null when Env Catalog cannot be asked. */
  secrets?: () => Promise<Array<{ name: string; kind: string }> | null>;
  hosts?: () => Promise<Array<{ id: string; name: string; connected: boolean }>>;
  /** The Browser QA machine of the project (setting browser_qa.host_id). */
  browserHostId?: () => string | null;
  specialists?: readonly string[];
};

export type CapabilityQuery = { sections?: string[]; query?: string };

export const CAPABILITY_SECTIONS = ["skills", "plugins", "mcpServers", "secrets", "hosts", "browser", "specialists", "reference"] as const;
const LIMIT = 120;

async function section<T>(read: (() => Promise<T[] | null>) | undefined, filter: (item: T) => boolean): Promise<Section<T>> {
  if (!read) return { status: "unavailable", items: [] };
  try {
    const items = await read();
    if (!items) return { status: "unavailable", items: [] };
    const matched = items.filter(filter);
    return { status: "ready", items: matched.slice(0, LIMIT), ...(matched.length > LIMIT ? { total: matched.length } : {}) };
  } catch (cause) {
    return { status: "error", items: [], error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** The vocabulary of the chain format, so the architect writes only what the validator accepts. */
export const WORKFLOW_REFERENCE = {
  nodeTypes: {
    agent: "a model thread does one job: role, prompt, skills, plugins (BB plugin ids its session may load) and mcp (MCP server names) on top of its role's, environment (none|project|worktree|personal), out = the fields it must return; every agent also returns a non-empty `handoff`",
    "lp-task": "a code change through Lane Pilot's writer, critics, checks and merge (owns_paths, contract); use it for anything that edits a repository",
    action: "a deterministic step run by code: `action` names it (telegram.send_rich, fs.write, items.dedupe ...), `params` feed it; `action: emit` ends the workflow with `map` (status and the workflow outputs)",
    decision: "branches on fields already produced (reads_node) without a model call",
    human: "asks the owner (question, options, timeoutSec); out usually answer and answer_kind (an enum the edges branch on)",
    parallel: "fans out over a list (for_each, batch_size, max_fan_out) with a `child` body and a `join`",
    join: "collects the branches of a parallel (only when the parallel has no child)",
    subworkflow: "calls another workflow by id; at most 3 levels",
    note: "a comment on the canvas; never runs",
  },
  passModes: Object.fromEntries(PASS_MODES.map((mode) => [mode, ({
    artifact: "the default: only the fields named in the edge's `with` reach the next node",
    "same-session": "the next agent continues in the same thread as the source agent (revisions, review loops)",
    "read-prior-session": "the next agent starts fresh and reads the earlier agent's handoff",
    fork: "the next agent starts from a copy of the source agent's session",
  } as Record<string, string>)[mode]])),
  qualityModes: Object.fromEntries(QUALITY_MODES.map((mode) => [mode, ({
    quick: "fewest review stages", standard: "the default review", full: "adds the extra critics and the browser check",
  } as Record<string, string>)[mode]])),
  conditions: {
    ops: [...CONDITION_OPS],
    expressions: "`a.b == 'x'`, `a.n < $inputs.min`, `!a.ok`, `a.list.length > 0`, `visits('node') < 3`, `&&`, `||`; only fields declared in the source node's `out` may be read",
  },
  fieldTypes: [...FIELD_TYPES],
  guards: "every loop needs `maxVisits` on one of its nodes or a `visits()` condition; `maxAttempts` (at most 5) retries a step; guards.maxSteps (default 60) and budget cap a run",
  edges: "`from: start` begins the chain; every path ends in an `emit` action (or an edge to `end`); several conditional edges plus at most one unconditional fallback leave a node",
} as const;

export async function collectCapabilities(ports: CapabilityPorts, query: CapabilityQuery = {}) {
  const wanted = (name: string) => !query.sections?.length || query.sections.includes(name);
  const needle = query.query?.trim().toLowerCase();
  const matches = (...texts: Array<string | undefined | null>) => !needle || texts.some((text) => text?.toLowerCase().includes(needle));

  const result: Record<string, unknown> = {};
  if (wanted("skills")) result.skills = await section(ports.skills && (async () => (await ports.skills!()).map((skill) => ({ name: skill.name, description: (skill.description ?? "").slice(0, 160), ...(skill.pluginId ? { plugin: skill.pluginId } : {}) }))), (item) => matches(item.name, item.description));
  if (wanted("plugins")) result.plugins = await section(ports.plugins && (() => ports.plugins!()), (item) => matches(item.id, item.name));
  if (wanted("mcpServers")) result.mcpServers = await section(ports.mcpServers && (() => ports.mcpServers!()), (item) => matches(item.name));
  if (wanted("secrets")) {
    const names = await section(ports.secrets && (async () => (await ports.secrets!())?.map((entry) => ({ name: entry.name, kind: entry.kind })) ?? null), (item) => matches(item.name));
    result.secrets = { ...names, note: "names and kinds only, never values; a node that needs one declares it in requires.secrets, and a missing one is asked from the owner with env_request" };
  }
  if (wanted("hosts")) result.hosts = await section(ports.hosts && (() => ports.hosts!()), (item) => matches(item.id, item.name));
  if (wanted("browser")) {
    const plugins = ports.plugins ? await ports.plugins().then((rows) => rows.map((row) => row.id), () => null) : null;
    const skills = ports.skills ? await ports.skills().then((rows) => rows.map((row) => row.name), () => null) : null;
    result.browser = {
      browserMachine: ports.browserHostId?.() ?? null,
      howToUse: [
        "an agent node with skills browser-automation (persistent pages, snapshots, forms) or computer-use (one goal in the owner's signed-in Chrome through jev) and role errand-style prompt",
        "a PM chat reaches the same browser through lane_pilot_browser (one step) and lane_pilot_errand (long jobs); a chain agent node uses the skills instead",
        "set requires.browserSession: true so the library shows that the chain needs the signed-in browser",
      ],
      browserAutomationPlugin: plugins ? plugins.includes("browser-automation") : null,
      skills: skills ? Object.fromEntries(["browser-automation", "computer-use", "browser-qa", "social-browser"].map((name) => [name, skills.includes(name)])) : null,
    };
  }
  if (wanted("specialists")) result.specialists = { roles: [...(ports.specialists ?? [])], note: "specialist profiles that exist in Lane Pilot; name one as the role of an agent node whose job matches it. Code changes go through an lp-task node, never an agent" };
  if (wanted("reference")) result.reference = WORKFLOW_REFERENCE;
  return result;
}

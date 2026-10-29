import { ROLE_TABLE, findModel, findProvider, offeredOnHost, resolveRoleModel, type ModelCatalog } from "@lane-pilot/models";
import { ARTIFACTS, artifactId } from "./artifacts";
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
  /** The providers and models the machines offer (the catalog of the Models view) and the settings the role table is read from; null when it cannot be asked. */
  models?: () => Promise<{ catalog: ModelCatalog; settings: Record<string, unknown> } | null>;
  /** The Browser QA machine of the project (setting browser_qa.host_id). */
  browserHostId?: () => string | null;
  /** The ids a node may name as `specialist:<id>`: the bundled specialists and the agents the owner created. */
  specialists?: readonly string[] | (() => Promise<readonly string[]>);
};

export type CapabilityQuery = { sections?: string[]; query?: string };

export const CAPABILITY_SECTIONS = ["skills", "plugins", "mcpServers", "secrets", "hosts", "browser", "specialists", "models", "reference"] as const;
const LIMIT = 120;

/**
 * The table «role -> model» as it stands now: for each role the model it runs on (the owner's row, else a stage selection set before
 * the table, else the built-in default), the effort, where that comes from, and whether the machine the helpers run on offers it.
 * A node names no model: the model belongs to the role, set once for every graph in Settings. Pure: the server passes the catalog.
 */
export function modelsSection(catalog: ModelCatalog, settings: Record<string, unknown>, needle?: string) {
  const hostName = new Map(catalog.hosts.map((host) => [host.id, host.name]));
  const wanted = needle?.trim().toLowerCase();
  const roles = Object.fromEntries(ROLE_TABLE.filter((row) => !wanted || row.id.includes(wanted)).map((row) => {
    const chosen = resolveRoleModel(row.id, settings);
    const model = findModel(findProvider(catalog, chosen.providerId), chosen.model);
    return [row.id, {
      provider: chosen.providerId, model: chosen.model, reasoning: chosen.effort, source: chosen.source, why: row.default.why,
      offered: Boolean(model?.hostIds.length) && offeredOnHost(catalog, chosen.providerId, chosen.model, catalog.runHostId) !== false,
      ...(model?.hostIds.length ? { machines: model.hostIds.map((id) => hostName.get(id) ?? id) } : {}),
    }];
  }));
  return {
    status: "ready" as const,
    machines: catalog.hosts.map((host) => ({ name: host.name, connected: host.connected })),
    roles,
    note: "a step names a `role`, never a model: the role picks its row of this table, and the owner sets the table once in Settings for every graph. Do not put `provider`, `model`, `reasoning` or `model_preset` on a node (the validator warns and the run ignores them). Pick the role by the job; `offered: false` means the machine this project's helpers run on lacks the model (the step then takes the role's default, then the PM chat's model)",
  };
}

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
    agent: "a model thread does one job: `role` (see roles: it sets what the thread can read and use), `prompt`, `skills`, `plugins` (BB plugin ids) and `mcp` (MCP server names) on top of its role's, `model_preset` or `provider`/`model`/`reasoning`/`service_tier` (see models), `session: new` (do not continue the earlier thread on a same-session edge), `votes` (1-9 independent runs decided by code), `out` = the fields it must return; every agent also returns a non-empty `handoff`. `authorized` (true: the helper may make the reversible changes the approved outcome needs outside the repository; false: read and report only; absent: the brief says nothing) is told to the helper in its brief. `environment` is accepted so older files load but changes nothing (the thread always runs in the PM chat's environment) and the validator warns; do not set it",
    "lp-task": "a code change through Lane Pilot's writer, critics, checks and merge (owns_paths, contract); use it for anything that edits a repository",
    action: "a deterministic step run by code: `action` names it (telegram.send_rich, fs.write, items.dedupe ...), `params` feed it; `action: emit` ends the workflow with `map` (status and the workflow outputs)",
    decision: "branches on fields already produced (reads_node) without a model call",
    human: "asks the owner as a form in the project's Lane Pilot chat (question, options, timeoutSec; onTimeout `stop`, or `default` with `defaultOption`); out usually answer and answer_kind (an enum the edges branch on). With a timeoutSec add `timeout` to the answer_kind values and give it an edge, else the step fails with human_timeout",
    parallel: "fans out over a list (for_each, batch_size) with a `child` body (agent, lp-task, action or subworkflow) and a `join` {policy all|majority|all_or_low_confidence, out, uses}; `max_fan_out` caps the branches (overflow fails unless onOverflow: truncate), `concurrency` how many run at once",
    join: "collects the branches of a parallel that has no child",
    subworkflow: "calls another workflow by id; at most 3 levels",
    note: "a comment on the canvas; never runs",
  },
  passModes: Object.fromEntries(PASS_MODES.map((mode) => [mode, ({
    artifact: "the default: only the fields named in the edge's `with` reach the next node",
    "same-session": "the next agent continues in the same thread as the source agent (revisions, review loops)",
    "read-prior-session": "the next agent starts fresh and reads the earlier agent's handoff",
    fork: "accepted, but no executor forks a session today: the next agent starts fresh with the mapped fields, as in artifact. Use artifact or read-prior-session",
  } as Record<string, string>)[mode]])),
  qualityModes: Object.fromEntries(QUALITY_MODES.map((mode) => [mode, ({
    quick: "fewest review stages", standard: "the default review", full: "adds the extra critics and the browser check",
  } as Record<string, string>)[mode]])),
  conditions: {
    ops: [...CONDITION_OPS],
    expressions: "`a.b == 'x'`, `a.n < $inputs.min`, `!a.ok`, `a.list.length > 0`, `visits('node') < 3`, `&&`, `||`; only fields declared in the source node's `out` may be read",
  },
  fieldTypes: [...FIELD_TYPES],
  guards: "every loop needs `maxVisits` on one of its nodes or a `visits()` condition; `maxAttempts` (at most 5) retries a step; `timeoutSec` bounds one; guards.maxSteps (default 60) and `budget` {maxSteps, maxTokens, maxCostUsd, maxWallSeconds} cap a run (over budget: the run is blocked)",
  edges: "`from: start` begins the chain; every path ends in an `emit` action (or an edge to `end`); several conditional edges plus at most one unconditional fallback leave a node",
  skipping: "`applicable_modes` (the node runs only in these quality modes), `skip_when` (an expression) and `skip_out` (the output of a skipped node; required when a later node reads its fields)",
  workflowQualityMode: "workflow `quality_mode` {default, effect, min, fixed}: order is contract, node, workflow, project; `min` raises a lower request; `fixed` wins over an inherited mode; a contract or explicit input of full inside fixed quick is a conflict, not a silent quick",
  roles: {
    "analyst, planner, auditor, debugger": "read-only thin roles: they read the code graph (gitnexus) and nothing else, no browser, no accounts. An unknown role, the default `worker` included, runs as `analyst`",
    "plan-critic, pm-reader, council, memory": "answer from the message alone: no tools, no code graph",
    "code-critic, triager": "read-only, code graph",
    errand: "work outside the code: the owner's browser (browser-automation, computer-use), Env Catalog accounts by name (env_get), mail, consoles",
    "browser-qa": "a browser check of a URL with cases; browser-automation only",
    "project-life": "may write .agents/ and CHANGELOG.md",
    "specialist:design-lead, specialist:copy-lead, specialist:seo-specialist, specialist:tavily, specialist:video-lead, specialist:<id of an agent the owner created>": "the specialists with their skills (an owner's agent runs with its own prompt, skills, MCP servers and model; the ids are in the specialists section of the capabilities); may write .agents/",
    note: "every role but project-life and the specialists is read-only for the repository: a changed file fails the step (repo_edited). A file the chain must leave in the project goes through an `fs.write` action or an lp-task node; notes go under .bb/chats/",
  },
  models: {
    precedence: "the model of an agent step (and of an action that runs in a helper) belongs to its `role`: one table «role -> model» in Settings, the same in every graph. A role's row is the owner's pick, else the stage selection the owner set before the table existed (analyst, planner and workflow-architect: none; pm-reader: pm_read; plan-critic: plan_critique; code-critic: code_critique; auditor: code_critique, then night_review; debugger: workflow.debugger, then specialist; specialist-reviewer and specialist:x: specialist; errand: errand), else the built-in default (authors on Claude Opus 5.5, judges on GPT-6.1 Sol, cheap jobs on Haiku 5.5, Sonnet 5.5 or GPT-6 Luna). An lp-task node runs on the writer chain (writer.* in Settings, Jev's pick per task); decision, human and code actions use no model",
    advice: "put no model on a node: choose the role by the job. `provider`, `model`, `reasoning`, `service_tier` and `model_preset` on a node change nothing and the validator warns about them",
  },
  requires: "`skills` (a hint on a step; only the ones listed here are checked before a run), `plugins` and `mcp` (those named on agent steps are added by themselves), `secrets` (Env Catalog names, `NAME?` when optional), `tools` (commands: `ffmpeg`, `a|b`), `platforms` (threads, instagram, facebook, vk are checked, x is not), `machines` (shown to the owner, not passed to a step), `browserSession`. A step that needs an account or a key runs as role `errand`: it reads the value by name with env_get and never prints it",
  actions: {
    code: "items.dedupe, dag.validate, digest.check, citations.check, verdict.aggregate, lp.propose_workflow; `emit` ends the chain",
    "plugin state and checkout": "lp.state_probe, lp.run_status, lp.run_close, lp.lint_contract, lp.integration_gate_status (answers skipped today), fs.write, git.diff_files",
    "run in an errand helper with its skills and accounts": "telegram.send_rich, shell.skill_script, shell.repo_script, deploy.post_check, lp.preflight, lp.project_checks; the node takes `model_preset` and `params.skill`",
    note: "an action name outside these lists has no executor: it runs on stubs in the test and a live run stops there",
  },
  triggers: "`triggers: [{type: chat|manual|schedule|telegram}]`. chat: the PM routes a request to a published chain; the router reads description, examples and not_for. manual: Run in the Workflows tab. schedule {cron (5 fields), timezone (IANA), projectId, inputs}: publishing a chain that has one creates a BB automation; a scheduled run starts only while the chain is published and the project has an open Lane Pilot chat, else the automation shows a failed run, and it gets only the trigger's inputs (a required input needs a value there or a default). telegram: declared only; no bot command starts a chain yet",
  testing: "`test` = {id, sim: {input, stubs: {nodeId: {field: value}}, human_answers: {nodeId: answer_kind}, expect_status (default succeeded), expect_path, expect_output, variant_<name>: {overrides}}}. Unstubbed fields get the first enum value and made-up strings, so stub every node that decides a branch. No `test`: one smoke case. Publishing needs every case green on the current version; any patch resets that",
  contracts: `the contract of a step (every node may carry it): \`produces: [{kind, version, field?, each?}]\` says the step's output (or its field \`field\`, a list of them when \`each\`) is an artifact of a registered kind, checked when the step ends (an agent gets one repair turn; a step that still fails is not done); \`consumes: [{kind, version, from, as?}]\` says what it takes in and from which node (the validator checks that node produces it); \`gates: ["node.field >= 1"]\` are conditions on the step's own output in the language of \`when\`. An agent or code-task node without \`produces\` is a warning. The first message of a step with a contract is a start packet of about 3 KB (goal, inputs, what to produce, gates): an input over 400 characters stands in it as a file path and a one-line summary, and the helper opens the file when it needs the whole text. Kinds (\`kind/version\`, the fields the output must declare): ${ARTIFACTS.map((def) => `${artifactId(def)} (${def.required.join(", ")})`).join("; ")}. \`report/1\` (a handoff) is for a step whose product is files or side effects.`,
  goals: "a run started through the PM carries goals {id, done_when, evidence} that a model audit judges before the run closes, so write outputs it can point to (a path, a message id, a count)",
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
        "a PM chat reaches the same browser through lane_pilot_helpers {action:\"browser\"} (one step) and lane_pilot_errand (long jobs); a chain agent node uses the skills instead",
        "set requires.browserSession: true so the library shows that the chain needs the signed-in browser",
      ],
      browserAutomationPlugin: plugins ? plugins.includes("browser-automation") : null,
      skills: skills ? Object.fromEntries(["browser-automation", "computer-use", "browser-qa", "social-browser"].map((name) => [name, skills.includes(name)])) : null,
    };
  }
  if (wanted("models")) {
    try {
      const read = ports.models ? await ports.models() : null;
      result.models = read && read.catalog.providers.length ? modelsSection(read.catalog, read.settings, needle) : { status: "unavailable", note: "no machine answered the model catalog: the pairs cannot be verified, so name no provider/model (use a preset)" };
    } catch (cause) {
      result.models = { status: "error", error: cause instanceof Error ? cause.message : String(cause) };
    }
  }
  if (wanted("specialists")) {
    const note = "agents a node may run as: bundled specialists and agents the owner created (`custom`); set the node's role to `specialist:<id>`. An id that is not in this list fails validation. Code changes go through an lp-task node, never an agent";
    try {
      const roles = typeof ports.specialists === "function" ? await ports.specialists() : ports.specialists ?? [];
      result.specialists = { roles: [...roles], note };
    } catch (cause) {
      result.specialists = { status: "error", error: cause instanceof Error ? cause.message : String(cause) };
    }
  }
  if (wanted("reference")) result.reference = WORKFLOW_REFERENCE;
  return result;
}

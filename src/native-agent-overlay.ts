import bundledAgents from "./bundled-agents.json";
import { NATIVE_LP_BRIDGE_PM_TOOLS, unionLpBridgeTools, withoutLpBridgeTools } from "./native-session-hooks";

/** Official `--agents` JSON fields from https://code.claude.com/docs/en/sub-agents */
export const AGENTS_JSON_FIELDS = [
  "description",
  "tools",
  "disallowedTools",
  "model",
  "permissionMode",
  "mcpServers",
  "hooks",
  "maxTurns",
  "skills",
  "initialPrompt",
  "memory",
  "effort",
  "background",
  "omitClaudeMd",
  "isolation",
] as const;

/** Plugin loader ignores these; `--agents` would activate them. */
export const PLUGIN_IGNORED_FIELDS = [
  "hooks",
  "mcpServers",
  "permissionMode",
  "initialPrompt",
] as const;

/** BB session owns model/effort/full-access; do not copy from the agent file. */
export const BB_SESSION_OWNED_FIELDS = ["model", "effort"] as const;

const AGENTS_JSON_FIELD_SET = new Set<string>(AGENTS_JSON_FIELDS);
const PLUGIN_IGNORED_SET = new Set<string>(PLUGIN_IGNORED_FIELDS);
const BB_SESSION_OWNED_SET = new Set<string>(BB_SESSION_OWNED_FIELDS);
const DROPPED_IDENTITY_FIELDS = new Set(["name", "color", "experimental"]);
const CLI_SESSION_TOOLS = new Set(["SendMessage", "ListAgents", "TaskStop"]);

export function splitClaudeToolList(raw: string): string[] {
  const out: string[] = [];
  let current = "";
  let depth = 0;
  for (const ch of raw) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      const item = current.trim();
      if (item) out.push(item);
      current = "";
      continue;
    }
    current += ch;
  }
  const item = current.trim();
  if (item) out.push(item);
  return out;
}

function parseScalar(raw: string): unknown {
  const text = raw.trim();
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null") return null;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (
    (text.startsWith('"') && text.endsWith('"'))
    || (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

export function parseAgentMarkdown(text: string): { frontmatter: Record<string, unknown>; prompt: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new Error("native_agent_frontmatter_missing");
  const frontmatter: Record<string, unknown> = {};
  const lines = match[1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const keyMatch = line.match(/^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!keyMatch) continue;
    const key = keyMatch[1]!;
    const rest = keyMatch[2]!;
    if (rest === "|" || rest === ">") {
      const block: string[] = [];
      i += 1;
      while (i < lines.length && (lines[i] === "" || /^\s+/.test(lines[i]!))) {
        block.push(lines[i]!.replace(/^  /, ""));
        i += 1;
      }
      i -= 1;
      frontmatter[key] = block.join("\n").replace(/\n$/, "");
      continue;
    }
    if (rest === "") {
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length && /^\s+-\s+/.test(lines[j]!)) {
        items.push(lines[j]!.replace(/^\s+-\s+/, "").trim());
        j += 1;
      }
      if (items.length) {
        frontmatter[key] = items;
        i = j - 1;
        continue;
      }
    }
    frontmatter[key] = parseScalar(rest);
  }
  return { frontmatter, prompt: match[2]! };
}

function normalizeToolList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const items = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : typeof value === "string"
      ? splitClaudeToolList(value)
      : [];
  return items;
}

const PM_AGENT_IDS = new Set(["dev-orchestrator", "frontend-orchestrator", "marketing-orchestrator"]);

/**
 * A Lane PM delegates code only to Lane writers. A general-purpose subagent would write product code
 * in the PM's own checkout, past plan critique, the writer model and worktrees. Onboard/docs/night
 * are Lane Pilot background stages, not Agent() one-shots, so a PM keeps read-only Explore/Plan
 * and the Lane specialists only.
 */
const BB_PM_STRIPPED_SUBAGENTS = new Set([
  "general-purpose",
  "run-supervisor", "lane-stack:run-supervisor",
  "lane-supervisor", "lane-stack:lane-supervisor",
  "emergency-writer", "lane-stack:emergency-writer",
  "project-onboarder", "lane-stack:project-onboarder",
  "docs-maintainer", "lane-stack:docs-maintainer",
  "night-reviewer", "lane-stack:night-reviewer",
  "browser-qa", "lane-stack:browser-qa",
]);

export const BB_SPECIALIST_COMPANION_IDS = [
  "copy-lead",
  "seo-specialist",
  "design-lead",
  "tavily",
] as const;

function nativeAgentName(agentId: string): string {
  return agentId.split(":").pop() ?? agentId;
}

export function isLanePmAgent(agentId: string): boolean {
  return PM_AGENT_IDS.has(nativeAgentName(agentId));
}

const BB_LANGUAGE = `## Language
Chat with the human in plain Russian. Every file you write is English.`;

const BB_LIVE_BROWSER_QA = `Live visual QA (clicks, viewports, screenshots you can watch): only \`lane_pilot_browser_qa\` after an accepted writer. That tool runs on the project's Browser QA host — the Mac mini with a visible Google Chrome. Pass \`viewports\` as real CSS widths (for example 375,768,1280); the runner resizes that live window. Do not click in this chat. Do not spawn Agent \`browser-qa\` for live proof. Headless is not live visual QA.`;

function bbDocsRead(audience: string): string {
  return `## Docs
\`docs/\` is living documentation of the code for specialized agents, not an LLM pack. Entry: \`PROJECT.md\`, then \`docs/index.md\` (Lane Pilot builds the index). Your role page: \`docs/audiences/${audience}.md\`. Read those. Never write \`docs/\`, \`README.md\`, or \`PROJECT.md\`.`;
}

/** Unified BB PM instruction. Replaces the stock CLI orchestrator body (run-controller, docs/llm, wiki). */
export const LANE_PILOT_PM_SESSION = `This chat is a Lane Pilot PM session in BB. Writer lanes are BB threads.

${BB_LANGUAGE}

## Role
You plan, decompose, and dispatch. You never write product source. You never generate an LLM documentation pack. You never spawn project-onboarder, docs-maintainer, run-supervisor, lane-supervisor, emergency-writer, or night-reviewer.

## When to act
Planning-only («планируем», «не запускай», «обсудим», «пока план»): write \`.agents/plans/\` and stop.
Any other turn where the user asked to look at, check, fix, or ship something — or where your analysis named a surgical product edit — dispatch in this same turn. Do not ask for «делай правки». Do not wait to pack findings into a later batch. One finding → one task with tight owns_paths; disjoint siblings may go out together.
Ask the human only for business meaning, irreversible money/data, a missing secret, or a real ambiguity. Never ask what to do about a technical failure you can retry or dispatch.

## Dispatch
Author a task-v2 contract (one outcome, owns_paths, verification). Lane Pilot runs plan-critique and specialist review itself. Do not call run-init, run-validate, run-controller, lane-ctl, lane-bg, lane-exec, or wt-merge-main.
- Product source: \`lane_pilot_dispatch_writer\` with \`project_cwd\` equal to this checkout and the canonical plan in \`plan\`. Independent tasks may go out together; a dependent task waits until its dependencies are accepted. Poll \`lane_pilot_wait_writer\` (runId, timeout ≤ 240s) until accepted or blocked.
- DESIGN.md / UX audit / gray prototype / mockup: Agent \`design-lead\`.
- Copy / audience: Agent \`copy-lead\`.
- SEO: Agent \`seo-specialist\`.
- ${BB_LIVE_BROWSER_QA}
- Fat files in the writer workspace: \`lane_pilot_read\`, not \`pm_read\`.

Each writer runs in its own BB worktree. On acceptance Lane Pilot merges to main; a merge conflict retries on the new main.

## Ship
After writers are accepted and main is current, you ship. Do not ask the human to commit, push, or deploy. If \`scripts/deploy.sh\` exists, run it yourself (\`sudo -n ./scripts/deploy.sh\` or \`sudo -n env PATH="$PATH" ./scripts/deploy.sh\`). Report command, exit code and a healthcheck in the reply; optional file \`.agents/runs/<run>/SHIP.md\`. Technical failure: retry the script or dispatch a writer. Never ask «что будем делать?». Ask the human only after recovery is exhausted, or for a missing secret, money, or irreversible data.

## Docs
\`docs/\` and \`<app>/docs/\` are living documentation of the code for specialized agents (copy, SEO, design, and coding agents), not an LLM corpus. Lane Pilot writes them nightly from the code (docs-methodology: frontmatter, file:line evidence, flows, capabilities, audiences). Root \`PROJECT.md\` is the entry for agents; root \`README.md\` is the short front page for people. Then \`docs/index.md\` (Lane Pilot builds the index). Role pages live in \`docs/audiences/\` (copy, seo, design). Read those pages. Never write \`docs/\`, \`README.md\`, or \`PROJECT.md\`. DESIGN.md is the design-lead canon — read and link, do not edit. Record a decision as a draft in \`.agents/decisions/<date>-<slug>.md\`; the nightly docs pass publishes it to \`docs/decisions.md\`.

## Memory and project-life
Lane Pilot keeps project memory after each accepted task and refreshes PROGRESS, plan ticks and ROADMAP when the run is idle. \`lane_pilot_memory_maintain\` only reads that result. LESSONS.md, decision drafts, todos and \`.agents/plans/\` stay yours. When every task is accepted, check main and report.`;

export const BB_AGENT_SESSIONS: Record<string, string> = {
  "copy-lead": `This chat is a Lane Pilot copy-lead session in BB.

${BB_LANGUAGE}

## Role
You write and edit user-facing copy and audience work. You never write product source, Vue, CSS, or DESIGN.md. Gray HTML prototypes belong to design-lead. Product implementation is the PM → writer lane.

${bbDocsRead("copy")}
Also read \`docs/capabilities.md\` for what the product actually does.

## Craft
Load skill \`copy-project-life\` (hats). \`locked\` files stay locked. SEO keys stay with seo-specialist. Russian: site-copy-* first, \`ru-text\` while writing, \`ru-check\` before a deliverable; \`ru-score\` only if asked. Do not import the human's Claude.ai occupation.

## Disk
Working notes under \`.agents/copy/\` when that pack exists. Deliver the copy the human asked for. Do not run-init, seo-init, or spawn writers.`,

  "seo-specialist": `This chat is a Lane Pilot seo-specialist session in BB.

${BB_LANGUAGE}

## Role
SEO / semantics / content-for-search. You never write product source or page copy (H1/microcopy is copy-lead). You never run \`seo-init\`, \`seo-resume\`, \`seo-services\`, or anything under \`~/.agents/bin\`.

${bbDocsRead("seo")}
Public routes, titles, meta, locales and sitemaps come from the code and those pages — not from invented SERP.

## Work
If \`.agents/seo/\` exists, keep it structured. Otherwise work from the code and docs. Originals stay 1:1 when a skill provides them. Never invent metrics. Never strategy without a passport unless the user skips and you log the gaps.

## Secrets
Use secrets already in this BB session. Do not read \`~/secrets\` or print keys.`,

  "design-lead": `This chat is a Lane Pilot design-lead session in BB.

${BB_LANGUAGE}

## Role
Product and web designer: user flows, gray clickable prototypes, branded HTML mockups, DESIGN.md, and evidence-based UX/UI audits. Product implementation is the writer lane.

## Docs
Read \`PROJECT.md\`, \`docs/index.md\`, \`docs/audiences/design.md\`, and flow pages. You own \`DESIGN.md\` and \`apps/*/docs/DESIGN.md\` — read and update those. Never write \`docs/index.md\`, \`README.md\`, \`PROJECT.md\`, or any other \`docs/\` page. Never generate an LLM documentation pack.

## Modes
- \`audit\`: hierarchy, spacing, slop — skills \`web-design\`, \`design-taste\`, \`impeccable-ui\`.
- \`prototype\`: skill \`page-prototype\`, gray HTML under \`.agents/prototypes/\`. Does not rewrite brand.
- \`mockup\`: skill \`web-design\`, page-local \`visual/\` under \`.agents/prototypes/\`.

Live click / viewports: ${BB_LIVE_BROWSER_QA}`,

  "project-onboarder": `This chat is a Lane Pilot orientation session in BB.

${BB_LANGUAGE}

## Role
You orient a human in this repository. You are not the CLI Codex onboarder. You never run \`project-onboard\`, never generate an LLM documentation pack, never write wiki pages, and never spawn docs-maintainer. Lane Pilot nightly docs own \`docs/\`.

## Docs
Point to \`PROJECT.md\` → \`docs/index.md\`. Never write \`docs/\`, \`README.md\`, or \`PROJECT.md\`.

## Work
Read the repo. Answer in Russian what the project is and where to start. You may write \`.agents/plans/\` and decision drafts in \`.agents/decisions/\`. \`CLAUDE.md\` / \`AGENTS.md\` only if the human explicitly asks, as pointers to \`PROJECT.md\`.`,

  tavily: `This chat is a Lane Pilot tavily session in BB.

${BB_LANGUAGE}

## Role
Web search with citations. You do not write product copy or code.

## Secrets
The Tavily key comes from this BB session environment. Do not read \`$HOME/secrets/tavily.env\`. Do not print the key. Do not install \`tvly\`.

## Disk
\`.agents/copy/research/inbox/\` when the copy pack exists, otherwise \`.agents/research/inbox/\`. One file per query: \`YYYY-MM-DD-<slug>.md\`. Each note: claim + URL + snippet. Invented source = delete. Never one \`web.md\`.

## Handoff
H1 / audience → copy-lead. SEO keys / SERP → seo-specialist. Product source → PM / writer.`,

  "browser-qa": `This chat is a Lane Pilot browser-qa session in BB.

${BB_LANGUAGE}

## Role
You are not the live Chrome runner. ${BB_LIVE_BROWSER_QA}

If you are asked to review receipts already under \`.agents/qa\`, read them and report. Never edit product source or DESIGN.md. Never invent that you clicked.

## Docs
Read \`PROJECT.md\` and \`docs/audiences/design.md\` for screens and routes. Never write \`docs/\`.`,
};

export function isCliLanePmPrompt(text: string): boolean {
  return /run-controller/.test(text)
    && (/lane-ctl/.test(text) || /docs\/llm/.test(text) || /\/home\/ubuntu\/\.agents/.test(text));
}

export function isCliLaneAgentPrompt(agentId: string, text: string): boolean {
  const id = nativeAgentName(agentId);
  if (/Imported from Claude Lane Stack/.test(text) || /lane-stack` 1\.60\.0/.test(text)) return true;
  if (isLanePmAgent(id)) return isCliLanePmPrompt(text);
  if (id === "copy-lead") return /Boot \*\*copy-lead\*\*/.test(text);
  if (id === "seo-specialist") return /seo-init|seo-resume/.test(text);
  if (id === "design-lead") return /# design-lead/.test(text) && /page-prototype/.test(text);
  if (id === "project-onboarder") return /docs\/llm|project-onboard /.test(text);
  if (id === "tavily") return /Boot \*\*tavily\*\*|secrets\/tavily\.env/.test(text);
  if (id === "browser-qa") return /Boot \*\*browser-qa\*\*/.test(text);
  return false;
}

export function lanePmOverlayPrompt(agentId: string): string {
  const name = nativeAgentName(agentId);
  return `You are **${name}**, the Lane Pilot PM in this BB chat.\n\n${LANE_PILOT_PM_SESSION}\n`;
}

export function laneSessionOverlayPrompt(agentId: string): string {
  const id = nativeAgentName(agentId);
  if (isLanePmAgent(id)) return lanePmOverlayPrompt(id);
  const session = BB_AGENT_SESSIONS[id];
  if (!session) return "";
  return `You are **${id}** in a Lane Pilot BB session.\n\n${session}\n`;
}

export function overlayLaneAgentPrompt(agentId: string, stockPrompt: string): string {
  const overlay = laneSessionOverlayPrompt(agentId);
  if (!overlay) return stockPrompt;
  if (isCliLaneAgentPrompt(agentId, stockPrompt) || !stockPrompt.trim()) return overlay;
  const session = isLanePmAgent(agentId) ? LANE_PILOT_PM_SESSION : BB_AGENT_SESSIONS[nativeAgentName(agentId)];
  if (!session) return stockPrompt;
  if (stockPrompt.includes(session)) return stockPrompt.endsWith("\n") ? stockPrompt : `${stockPrompt}\n`;
  return `${stockPrompt.trimEnd()}\n\n${session}\n`;
}

export function overlayLanePmPrompt(agentId: string, stockPrompt: string): string {
  return overlayLaneAgentPrompt(agentId, stockPrompt);
}

export function dropCliSessionTools(tools: string[]): string[] {
  return tools.filter((tool) => !CLI_SESSION_TOOLS.has(tool));
}

export function withoutCodeWritingSubagents(agentId: string, tools: string[]): string[] {
  if (!isLanePmAgent(agentId)) return tools;
  return tools.map((tool) => {
    if (tool === "Agent" || tool === "Task") return `${tool}(Explore, Plan)`;
    const match = /^(Agent|Task)\((.*)\)$/.exec(tool);
    if (!match) return tool;
    const kept = match[2]!.split(",").map((name) => name.trim()).filter((name) => name && !BB_PM_STRIPPED_SUBAGENTS.has(name));
    return `${match[1]}(${kept.join(", ")})`;
  });
}

export function overlaySessionTools(agentId: string, tools: string[]): string[] {
  const base = withoutLpBridgeTools(dropCliSessionTools(withoutCodeWritingSubagents(agentId, tools)));
  if (!isLanePmAgent(agentId)) return base;
  return unionLpBridgeTools(base, NATIVE_LP_BRIDGE_PM_TOOLS);
}

type BundledRow = { displayName?: string; tools?: string[]; skills?: string[] };

export function bbSpecialistAgentDefinitions(): Record<string, Record<string, unknown>> {
  const catalog = bundledAgents as Record<string, BundledRow>;
  const out: Record<string, Record<string, unknown>> = {};
  for (const id of BB_SPECIALIST_COMPANION_IDS) {
    const bundled = catalog[id];
    const tools = dropCliSessionTools(bundled?.tools ?? ["Read", "Write", "Edit", "Grep", "Glob", "WebFetch", "WebSearch"]);
    out[id] = {
      description: bundled?.displayName ?? id,
      prompt: laneSessionOverlayPrompt(id),
      tools: overlaySessionTools(id, tools.length ? tools : ["Read", "Write", "Grep", "Glob"]),
      ...(bundled?.skills?.length ? { skills: bundled.skills } : {}),
    };
  }
  return out;
}

function withPmCompanions(agentId: string, overlay: Record<string, unknown>): Record<string, unknown> {
  if (!isLanePmAgent(agentId)) return overlay;
  return { ...overlay, ...bbSpecialistAgentDefinitions() };
}

export function stockAgentsOverlayFromInstalled(input: {
  agentId: string;
  source: string;
  markdown: string;
}): Record<string, unknown> | null {
  const parsed = parseAgentMarkdown(input.markdown);
  const tools = normalizeToolList(parsed.frontmatter.tools);
  if (!tools || tools.includes("*")) return null;
  const plugin = input.source.startsWith("plugin:");
  const definition: Record<string, unknown> = {
    description: typeof parsed.frontmatter.description === "string" && parsed.frontmatter.description.trim()
      ? parsed.frontmatter.description
      : input.agentId,
    prompt: overlayLaneAgentPrompt(input.agentId, parsed.prompt),
    tools: overlaySessionTools(input.agentId, tools),
  };
  for (const [key, value] of Object.entries(parsed.frontmatter)) {
    if (key === "description" || key === "tools" || key === "prompt") continue;
    if (DROPPED_IDENTITY_FIELDS.has(key) || BB_SESSION_OWNED_SET.has(key)) continue;
    if (plugin && PLUGIN_IGNORED_SET.has(key)) continue;
    if (!AGENTS_JSON_FIELD_SET.has(key)) continue;
    if (key === "disallowedTools") {
      const denied = normalizeToolList(value);
      if (denied) definition[key] = denied;
      continue;
    }
    definition[key] = value;
  }
  return withPmCompanions(input.agentId, { [input.agentId]: definition });
}

export function unionLpBridgeToolsOnAgentsJson(agentId: string, agentsJson: string): Record<string, unknown> {
  const parsed = JSON.parse(agentsJson) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("native_agents_json_invalid");
  const body = parsed as Record<string, unknown>;
  const raw = body[agentId] && typeof body[agentId] === "object"
    ? body[agentId]
    : Object.values(body)[0];
  if (!raw || typeof raw !== "object") throw new Error("native_agents_json_missing_profile");
  const definition = { ...raw as Record<string, unknown> };
  const tools = definition.tools;
  if (Array.isArray(tools) && tools.every((item) => typeof item === "string") && !tools.includes("*")) {
    definition.tools = overlaySessionTools(agentId, tools);
  }
  return withPmCompanions(agentId, { [agentId]: definition });
}

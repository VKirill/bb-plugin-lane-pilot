import type { Workflow } from "./schema";

/**
 * The check before a live run of a workflow (W8): does everything it says it needs exist where it runs? Skills, plugins, MCP
 * servers, Env Catalog names (never values), commands on the machine (`ffmpeg`, `yt-dlp`), signed-in social networks. A source
 * that cannot be asked gives an `unverified` note and does not stop the run; something that is asked and absent is `missing` and
 * stops it, with a message the owner can act on. Free text in `requires.secrets` / `machines` / `env` (older files describe
 * the machine in words) is shown in the library and not checked.
 */
export type RequirePorts = {
  skills?: () => Promise<string[]>;
  plugins?: () => Promise<string[]>;
  mcpServers?: () => Promise<string[]>;
  /** Env Catalog entries; null when it cannot be asked. */
  secrets?: () => Promise<Array<{ name: string; kind: string }> | null>;
  /** Which of the command groups exist on the run's machine, by index; null when the machine cannot be asked. */
  commands?: (groups: string[][]) => Promise<boolean[] | null>;
  /** The text of `social-cookies status` on the run's machine; null when it cannot be read. */
  socialStatus?: () => Promise<string | null>;
};

export type RequireKind = "skill" | "plugin" | "mcp" | "secret" | "tool" | "platform";
export type RequireIssue = { kind: RequireKind; name: string; level: "missing" | "unverified"; message: string };
export type PreflightResult = {
  ok: boolean;
  issues: RequireIssue[];
  /** What the PM asks the owner for with `env_request` (a masked form), never in chat. */
  envRequests: Array<{ name: string; kind: "secret"; purpose: string }>;
  /** What was looked at, so a screen can show a tick for the rest. */
  checked: Array<{ kind: RequireKind; name: string }>;
};

/** The platforms `social-browser` keeps logins for, and how they show in `social-cookies status`. Others (X, whose session lives in the browser profile) cannot be checked and are reported as not checked. */
export const PLATFORM_DOMAINS: Record<string, RegExp> = {
  threads: /threads\.(com|net)/i, instagram: /instagram\.com/i, facebook: /facebook\.com/i, vk: /vk\.com/i,
};

/** `TAVILY_API_KEY`, `MUTAGEN_API_KEY?` or `MUTAGEN_API_KEY (only when seo tools are on)` → the name and whether it is optional; prose is not a name. */
export function secretName(entry: string): { name: string; optional: boolean } | null {
  const found = entry.trim().match(/^([A-Z][A-Z0-9_]{2,})(\?)?(?:\s+(.*))?$/s);
  if (!found) return null;
  const rest = found[3] ?? "";
  return { name: found[1]!, optional: found[2] === "?" || /\((?:only|optional|только|если)/i.test(rest) };
}

/** A tool entry: `ffmpeg`, or any of `whisper|whisper-cpp|faster-whisper`, or a path like `~/toolkit/telegram/tg`. */
export const toolGroup = (entry: string): string[] => entry.split("|").map((part) => part.trim()).filter((part) => /^[A-Za-z0-9._+/~-]{1,100}$/.test(part));

/** Ids older files and authors use for a plugin whose real id is another (`bb plugin list` knows `tasks`, not `bb-tasks`). */
export const PLUGIN_ALIASES: Readonly<Record<string, string>> = { "bb-tasks": "tasks" };
export const pluginId = (name: string): string => PLUGIN_ALIASES[name] ?? name;

const within = async <T>(read: (() => Promise<T>) | undefined): Promise<{ ok: true; value: T } | { ok: false }> => {
  if (!read) return { ok: false };
  try { return { ok: true, value: await read() }; } catch { return { ok: false }; }
};

/**
 * What the workflow needs in all: its `requires` and the BB plugins and MCP servers its agent steps name, so a step that asks for a
 * plugin or a server nobody installed is found before the run, not by a helper that starts without it. (The skills of a step stay a
 * hint in its brief, as before; the workflow lists the ones it cannot do without in `requires.skills`.)
 */
export function effectiveRequires(workflow: Workflow): Workflow["requires"] {
  const plugins = new Set(workflow.requires.plugins), mcp = new Set(workflow.requires.mcp);
  const bodies = workflow.nodes.flatMap((node) => (node.type === "agent" ? [node] : node.type === "parallel" && node.child?.type === "agent" ? [node.child] : []));
  for (const body of bodies) {
    for (const name of body.plugins ?? []) plugins.add(name);
    for (const name of body.mcp ?? []) mcp.add(name);
  }
  return { ...workflow.requires, plugins: [...plugins], mcp: [...mcp] };
}

export async function checkRequires(requires: Workflow["requires"], ports: RequirePorts): Promise<PreflightResult> {
  const issues: RequireIssue[] = [];
  const checked: PreflightResult["checked"] = [];
  const envRequests: PreflightResult["envRequests"] = [];
  const note = (kind: RequireKind, name: string, level: RequireIssue["level"], message: string) => issues.push({ kind, name, level, message });

  const named = async (kind: RequireKind, names: string[], read: (() => Promise<string[]>) | undefined, noun: string, fix: string, resolve: (name: string) => string = (name) => name) => {
    if (!names.length) return;
    const have = await within(read);
    for (const name of names) {
      checked.push({ kind, name });
      if (!have.ok) { note(kind, name, "unverified", `${noun} "${name}" could not be checked here.`); continue; }
      if (!have.value.includes(resolve(name))) note(kind, name, "missing", `${noun} "${name}" is not available. ${fix}`);
    }
  };
  await named("skill", requires.skills, ports.skills, "Skill", "Install it, or enable it for this project.");
  await named("plugin", requires.plugins, ports.plugins, "BB plugin", "Install and enable it.", pluginId);
  await named("mcp", requires.mcp, ports.mcpServers, "MCP server", "Connect it on the machine the run works on.");

  const wanted = requires.secrets.map(secretName).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  if (wanted.length) {
    const catalog = await within(ports.secrets);
    for (const { name, optional } of wanted) {
      checked.push({ kind: "secret", name });
      if (!catalog.ok || catalog.value === null) { note("secret", name, "unverified", `Env Catalog could not be asked for ${name}.`); continue; }
      if (catalog.value.some((entry) => entry.name === name)) continue;
      if (optional) { note("secret", name, "unverified", `${name} is not in Env Catalog; it is needed only for some inputs.`); continue; }
      note("secret", name, "missing", `${name} is not in Env Catalog. Ask the owner for it with env_request (name ${name}, kind secret): a masked form, never the chat.`);
      envRequests.push({ name, kind: "secret", purpose: "needed by a Lane Pilot workflow" });
    }
  }

  const groups = requires.tools.map(toolGroup).filter((group) => group.length);
  if (groups.length) {
    const found = await within(ports.commands && (() => ports.commands!(groups)));
    groups.forEach((group, index) => {
      const name = group.join(" | ");
      checked.push({ kind: "tool", name });
      if (!found.ok || found.value === null) note("tool", name, "unverified", `${name} could not be looked for on the machine.`);
      else if (!found.value[index]) note("tool", name, "missing", `${name} is not installed on the machine the run works on (looked for ${group.join(", ")}). Install it there.`);
    });
  }

  if (requires.platforms.length) {
    const status = await within(ports.socialStatus);
    for (const platform of requires.platforms) {
      checked.push({ kind: "platform", name: platform });
      const domain = PLATFORM_DOMAINS[platform.toLowerCase()];
      if (!domain) { note("platform", platform, "unverified", `${platform}: no known way to check a login for it.`); continue; }
      if (!status.ok || status.value === null) { note("platform", platform, "unverified", `${platform}: the signed-in sessions could not be read (social-cookies is not on the machine).`); continue; }
      if (!domain.test(status.value)) note("platform", platform, "missing", `Not signed in to ${platform} for the browser: sign in in Chrome on the main machine and run social-cookies sync.`);
    }
  }

  return { ok: !issues.some((issue) => issue.level === "missing"), issues, envRequests, checked };
}

/** The PM's refusal text for a failed check: every missing thing with what to do, and the env_request lines. */
export function preflightRefusal(result: PreflightResult): string {
  const missing = result.issues.filter((issue) => issue.level === "missing");
  return `requirements_missing: ${missing.map((issue) => issue.message).join(" ")}${result.envRequests.length ? ` Call env_request now for ${result.envRequests.map((request) => request.name).join(", ")} (kind secret, purpose: what the workflow needs it for), then try again.` : ""}`;
}

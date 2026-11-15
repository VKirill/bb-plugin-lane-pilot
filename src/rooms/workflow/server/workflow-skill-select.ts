import type { ServerCore } from "../../contracts/server";
import { projectSources } from "../../platform/server";

/**
 * Optional node-local native skill selection (native-skill-delivery-implementation-packet): the node's own
 * `skills`/`profile.skills` hints are resolved against the actual target's command surface and attached as
 * `source:"skill"` mentions — a selection reference, never a claim that a provider loaded a skill body.
 * Workflow-level `requires.skills`, role allowlists and bundled-agent access stay policy-side and are not
 * merged here. Unsupported providers/workspaces get a named diagnostic and the unchanged prompt path.
 * Every entry point is total: routing/lookup failures return null/notes, never throw into the step.
 */

export type SkillRoute = { environmentId: string } | { hostId: string };

/** The placement shapes `run` computes for a helper: a reused chat environment or an unmanaged host folder. */
export type SkillWorkspace =
  | { type: "reuse"; environmentId: string }
  | { type: "host"; hostId: string; workspace: { path?: string | null } };

export interface SkillSelection {
  /** Spawn/send `input` parts: one `/<name>` mention part plus the unchanged prompt part. Null keeps `prompt`. */
  parts: Array<{ type: "text"; text: string; mentions: Array<Record<string, unknown>> }> | null;
  /** Named diagnostics for the step log (`selection_*`); empty when nothing was requested or all resolved. */
  notes: string[];
}

const NO_SELECTION: SkillSelection = { parts: null, notes: [] };

const normPath = (path: string) => path.replace(/\/+$/, "");

type EnvLite = { status?: unknown; hostId?: unknown; path?: unknown; projectId?: unknown } | null;
const envOf = (value: unknown): EnvLite => (value && typeof value === "object" ? (value as EnvLite) : null);

/** hostId routing is allowed only when the folder is a verified project source on that host (packet NSD-03). */
async function verifiedHostRoute(bb: ServerCore["bb"], projectId: string, hostId: string, path: string): Promise<SkillRoute | null> {
  const list = await projectSources(bb, projectId);
  return list.some((s) => s.hostId === hostId && typeof s.path === "string" && normPath(s.path) === normPath(path)) ? { hostId } : null;
}

/**
 * A ready environment counts only for the project it belongs to; a foreign project's environment is never a
 * valid selection target. Not-ready environments fall back to host routing only when host+path is a verified
 * project source of the same project.
 */
async function envRoute(bb: ServerCore["bb"], projectId: string, environmentId: string): Promise<SkillRoute | null> {
  const env = envOf(await bb.sdk.environments.get({ environmentId }).catch(() => null));
  if (env?.projectId !== projectId) return null;
  if (env.status === "ready") return { environmentId };
  const hostId = typeof env.hostId === "string" ? env.hostId : "";
  const path = typeof env.path === "string" ? env.path : "";
  return hostId && path ? await verifiedHostRoute(bb, projectId, hostId, path) : null;
}

/** Route for a fresh spawn target: ready same-project environment id, else a verified project-source host. */
export async function skillWorkspaceRoute(bb: ServerCore["bb"], projectId: string, workspace: SkillWorkspace): Promise<SkillRoute | null> {
  try {
    if (workspace.type === "reuse") return await envRoute(bb, projectId, workspace.environmentId);
    const path = workspace.workspace?.path;
    return workspace.hostId && typeof path === "string" && path ? await verifiedHostRoute(bb, projectId, workspace.hostId, path) : null;
  } catch {
    return null;
  }
}

/**
 * Route for `intoThread`: the actual continued thread's provider, project and environment — never the PM
 * request defaults. `projectId` in the result is the thread's own project (the passed id only when the
 * thread does not report one).
 */
export async function skillThreadRoute(
  bb: ServerCore["bb"],
  threadId: string,
): Promise<{ route: SkillRoute | null; provider: string; projectId: string } | null> {
  try {
    const thread = await bb.sdk.threads.get({ threadId }).catch(() => null);
    if (!thread || typeof thread !== "object") return null;
    const t = thread as { providerId?: unknown; environmentId?: unknown; projectId?: unknown };
    const provider = typeof t.providerId === "string" ? t.providerId : "";
    // A continued thread that does not report its own project cannot be verified: unverified, never the PM default.
    if (typeof t.projectId !== "string" || !t.projectId) return null;
    const threadProject = t.projectId;
    const environmentId = typeof t.environmentId === "string" ? t.environmentId : "";
    if (!environmentId) return { route: null, provider, projectId: threadProject };
    return { route: await envRoute(bb, threadProject, environmentId), provider, projectId: threadProject };
  } catch {
    return null;
  }
}

/**
 * Resolve the deduped node-local skill names against the target's `projects.commands` surface and build the
 * mention input. Codex attaches every resolved selection; claude-code attaches only when exactly one skill
 * was requested AND resolved; other providers report `selection_transport_unsupported` without a catalog
 * call. Lookup failures, malformed responses, missing names and ambiguous duplicates are diagnostics — the
 * prompt part is never altered.
 */
export async function nativeSkillSelection(args: {
  bb: ServerCore["bb"];
  projectId: string;
  provider: string;
  route: SkillRoute | null;
  skills: readonly string[];
  prompt: string;
}): Promise<SkillSelection> {
  const { bb, projectId, provider, route, prompt } = args;
  const wanted = [...new Set(args.skills.filter((s) => typeof s === "string" && s.length > 0))];
  if (!wanted.length) return NO_SELECTION;
  const tag = `provider=${provider} skills=${wanted.join(",")}`;
  if (provider !== "codex" && provider !== "claude-code")
    return { parts: null, notes: [`selection_transport_unsupported: ${tag} — no native skill selection transport`] };
  if (!route)
    return { parts: null, notes: [`selection_workspace_unverified: ${tag} — no ready environment or verified project source`] };

  let list: unknown;
  try {
    const call = "environmentId" in route
      ? { projectId, provider, environmentId: route.environmentId }
      : { projectId, provider, hostId: route.hostId };
    const res = await bb.sdk.projects.commands(call);
    list = (res as { commands?: unknown } | null)?.commands;
  } catch (cause) {
    return { parts: null, notes: [`selection_transport_unsupported: ${tag} — command lookup failed (${cause instanceof Error ? cause.message.slice(0, 120) : String(cause)})`] };
  }
  if (!Array.isArray(list) || list.some((c) => !c || typeof c !== "object"))
    return { parts: null, notes: [`selection_transport_unsupported: ${tag} — malformed command list response`] };
  if (!list.length)
    return { parts: null, notes: [`selection_transport_unsupported: ${tag} — provider advertises no command surface in the target workspace`] };

  const skillRows = (list as Array<Record<string, unknown>>).filter((c) => c.source === "skill" && typeof c.name === "string");
  const resolved: typeof skillRows = [];
  const notes: string[] = [];
  for (const name of wanted) {
    const matches = skillRows.filter((c) => c.name === name);
    if (matches.length === 1) resolved.push(matches[0]);
    else if (matches.length > 1) notes.push(`selection_ambiguous: ${tag} — '${name}' matches ${matches.length} skill commands`);
    else notes.push(`selection_unresolved: ${tag} — '${name}' is not advertised as a skill command`);
  }
  // Claude Code turns one selected skill into a slash invocation; multiple requested selections stay text.
  const claudeMulti = provider === "claude-code" && wanted.length > 1;
  if (claudeMulti) notes.push(`selection_transport_unsupported: ${tag} — claude-code attaches a single skill selection, ${wanted.length} requested`);
  if (!resolved.length || claudeMulti) return { parts: null, notes };

  const text = resolved.map((c) => `/${String(c.name)}`).join(" ");
  let offset = 0;
  const mentions = resolved.map((c) => {
    const token = `/${String(c.name)}`;
    const mention: Record<string, unknown> = {
      start: offset,
      end: offset + token.length,
      resource: {
        kind: "command",
        source: "skill",
        trigger: "/",
        name: c.name,
        origin: c.origin,
        label: c.name,
        ...(typeof c.argumentHint === "string" && c.argumentHint ? { argumentHint: c.argumentHint } : {}),
      },
    };
    offset += token.length + 1;
    return mention;
  });
  return {
    parts: [
      { type: "text", text, mentions },
      { type: "text", text: prompt, mentions: [] },
    ],
    notes,
  };
}

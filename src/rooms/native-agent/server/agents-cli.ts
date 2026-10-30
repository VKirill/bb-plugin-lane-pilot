import { parseAgentFile, type AgentListItem } from "../custom-agent";
import type { AgentRegistry } from "./agent-registry";

/**
 * `bb lane-pilot agents <list|show|create|update|delete>`: the agents the owner can pick, and his own among them.
 * The CLI runs on the hub, so a file is passed inline: `"$(cat video.md)"`.
 */
export const AGENTS_USAGE = [
  "bb lane-pilot agents list [--custom] [--json]",
  "bb lane-pilot agents show <id> [--json]",
  "bb lane-pilot agents create '<json or markdown with frontmatter>'",
  "bb lane-pilot agents update <id> '<json or markdown with frontmatter>'",
  "bb lane-pilot agents delete <id>",
].join("\n");

type Result = { exitCode: number; stdout: string };
type Deps = { list: () => Promise<AgentListItem[]>; registry: AgentRegistry };

export async function runAgentsCli(deps: Deps, args: string[]): Promise<Result> {
  const sub = args[0] ?? "";
  const rest = args.slice(1);
  const json = rest.includes("--json");
  const positional = rest.filter((arg) => !/^--[a-z][a-z-]*$/.test(arg));
  const out = (value: unknown): Result => ({ exitCode: 0, stdout: typeof value === "string" ? value : JSON.stringify(value, null, 2) });
  const fail = (message: string, extra: Record<string, unknown> = {}): Result => ({ exitCode: 1, stdout: JSON.stringify({ ok: false, error: message, ...extra }) });
  const result = async (id: string, done: Promise<Awaited<ReturnType<AgentRegistry["create"]>>>, state: string): Promise<Result> => {
    const outcome = await done;
    if (!outcome.ok) return fail(outcome.error, { id: outcome.id || id, ...(outcome.detail ? { detail: outcome.detail } : {}) });
    const agent = (await deps.list()).find((row) => row.id === outcome.id);
    return out({ ok: true, state, id: outcome.id, ...(agent ? { agent: { id: agent.id, displayName: agent.displayName, kind: agent.kind, custom: agent.custom, sourceHash: agent.sourceHash } } : {}) });
  };

  if (sub === "list") {
    const rows = (await deps.list()).filter((row) => !rest.includes("--custom") || row.custom);
    if (json) return out({ agents: rows });
    return out(rows.length ? rows.map((row) => `${row.id.padEnd(22)} ${row.kind.padEnd(11)} ${row.custom ? "custom" : "bundled"}  ${(row.domain ?? "general").padEnd(10)} ${(row.machineAffinity ?? "any").padEnd(10)} ${row.displayName}`).join("\n") : "no agents");
  }
  if (sub === "show" && positional[0]) {
    const row = (await deps.list()).find((item) => item.id === positional[0]);
    return row ? out(row) : fail("agent_not_found", { id: positional[0] });
  }
  if (sub === "create" && positional[0]) {
    let fields: Record<string, unknown>;
    try { fields = parseAgentFile(positional[0]); } catch (cause) { return fail("invalid_agent_file", { detail: cause instanceof Error ? cause.message : String(cause) }); }
    return result(String(fields.id ?? ""), deps.registry.create(fields), "created");
  }
  if (sub === "update" && positional[0] && positional[1]) {
    let fields: Record<string, unknown>;
    try { fields = parseAgentFile(positional[1]); } catch (cause) { return fail("invalid_agent_file", { detail: cause instanceof Error ? cause.message : String(cause) }); }
    // The id comes from the command; a different id in the file is a mistake.
    if (fields.id !== undefined && fields.id !== positional[0]) return fail("agent_id_mismatch", { id: positional[0], fileId: fields.id });
    return result(positional[0], deps.registry.update({ ...fields, id: positional[0] }), "updated");
  }
  if (sub === "delete" && positional[0]) return result(positional[0], deps.registry.remove(positional[0]), "deleted");
  return { exitCode: 1, stdout: `usage:\n${AGENTS_USAGE}` };
}

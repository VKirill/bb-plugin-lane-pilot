/** The ids the screen needs of a native session, without zod (see `owner-ask-shared.ts`); `native-session.ts` re-exports them. */
export const NATIVE_MENTION_PROVIDER = "lane-pilot";
export const CLI_AGENTS_PLUGIN_ID = "cli-agents";
export const DEFAULT_NATIVE_AGENT = "dev-orchestrator";
export const GUARD_PM_AGENTS = ["dev-orchestrator", "frontend-orchestrator", "marketing-orchestrator"] as const;

/** Claude `--agent` flag: short id. Runtime agentSetting is `plugin:short` (see live transcript). */
export function nativeAgentCliId(agentId: string): string {
  const trimmed = agentId.trim();
  if (!trimmed) throw new Error("native_agent_id_missing");
  const short = trimmed.includes(":") ? trimmed.slice(trimmed.lastIndexOf(":") + 1) : trimmed;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(short) || short.includes(":")) {
    throw new Error(`native_agent_id_invalid:${agentId}`);
  }
  return short;
}

export function nativeAgentSettingId(agentId: string, source?: string): string {
  const trimmed = agentId.trim();
  if (!trimmed) throw new Error("native_agent_id_missing");
  if (trimmed.includes(":")) return trimmed;
  const short = nativeAgentCliId(trimmed);
  if (source?.startsWith("plugin:")) {
    const plugin = source.slice("plugin:".length).trim();
    if (plugin) return `${plugin}:${short}`;
  }
  return short;
}

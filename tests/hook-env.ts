const SESSION_PREFIXES = ["LANE_PILOT_", "BB_", "CLAUDE_", "AGENT_"];

export function hookEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (SESSION_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

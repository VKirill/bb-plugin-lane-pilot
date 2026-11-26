import type { VkSessionPolicy } from "../../contracts";

/**
 * Session and terminal parity (SMA m_tl_terminal_parity): for one attempt, six layers — hooks,
 * memory, rules, skills, permissions, model — each line saying whether the BB session the attempt
 * ran in and a terminal session in the same project got the same layer. Read-only report.
 */
export const PARITY_LAYERS = ["hooks", "memory", "rules", "skills", "permissions", "model"] as const;
export type ParityLayer = (typeof PARITY_LAYERS)[number];
/** A layer is a list of entries, or null when that side has no record of it: such a layer is reported «not compared», never «same». */
export type ParityLayerSet = Record<ParityLayer, readonly string[] | null>;
export type ParityLine = { layer: ParityLayer; same: boolean | null; detail: string };

/** Why a layer is not compared: the attempt records no permission policy and a terminal's tool list is not readable from here. */
const NOT_COMPARED: Partial<Record<ParityLayer, string>> = {
  permissions: "not compared: permissions were not recorded on the attempt, or the terminal side could not be computed",
};

const diff = (a: readonly string[], b: readonly string[]) => {
  const left = a.filter((item) => !b.includes(item)).sort();
  const right = b.filter((item) => !a.includes(item)).sort();
  return { onlySession: left, onlyTerminal: right };
};

export function terminalParity(session: ParityLayerSet, terminal: ParityLayerSet): ParityLine[] {
  return PARITY_LAYERS.map((layer): ParityLine => {
    const left = session[layer];
    const right = terminal[layer];
    if (left === null || right === null) return { layer, same: null, detail: NOT_COMPARED[layer] ?? "not compared: one side has no record of this layer" };
    const gaps = diff(left, right);
    const same = gaps.onlySession.length === 0 && gaps.onlyTerminal.length === 0;
    const detail = same
      ? `${new Set(left).size} entr${new Set(left).size === 1 ? "y" : "ies"}`
      : [
          gaps.onlySession.length ? `only in the session: ${gaps.onlySession.join(", ")}` : "",
          gaps.onlyTerminal.length ? `only in the terminal: ${gaps.onlyTerminal.join(", ")}` : "",
        ].filter(Boolean).join("; ");
    return { layer, same, detail };
  });
}

/** A session's permission list as one sorted set of entries (SMA m_tl_terminal_parity): the guard's disallowed tools plus every narrowed policy group. */
export function permissionEntries(input: { policy?: VkSessionPolicy | null; disallowedTools?: string | readonly string[] }): string[] {
  const tools = typeof input.disallowedTools === "string" ? input.disallowedTools : (input.disallowedTools ?? []).join(",");
  const policy = input.policy ?? {};
  const group = (key: string, value: { mode?: string; names?: string[] } | undefined): string =>
    `${key}:${value?.mode ?? "inherit"}${value?.names?.length ? `(${(value.names ?? []).join(",")})` : ""}`;
  return [
    `disallowedTools:${tools}`,
    `required:${policy.required === true}`,
    group("bbPlugins", policy.bbPlugins),
    group("skills", policy.skills),
    group("mcpServers", policy.mcpServers),
    group("nativePlugins", policy.nativePlugins),
    `userInstructions:${policy.userInstructions ?? "unset"}`,
    `projectInstructions:${policy.projectInstructions ?? "unset"}`,
    `claudeAiSync:${policy.claudeAiSync ?? "unset"}`,
  ].sort();
}

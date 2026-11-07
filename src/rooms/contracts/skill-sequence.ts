/**
 * Extracts the sequence of skill invocations in chronological order from thread events or tool pairs.
 * If no explicit skill events are present, falls back to the provided candidate/assigned skills.
 */
export function extractSkillSequence(
  events: readonly unknown[] = [],
  fallbackSkills: readonly string[] = [],
): string[] {
  const sequence: string[] = [];

  for (const raw of events) {
    if (!raw || typeof raw !== "object") continue;
    const event = raw as Record<string, unknown>;
    const item = (event.data as { item?: Record<string, unknown> } | undefined)?.item ?? event;
    const type = String(item.type ?? "");
    const name = String(item.tool ?? item.name ?? "");

    // Direct skill tool invocations (e.g., skill({ id: "..." }))
    if (name === "skill" || name.endsWith(".skill") || type === "skill") {
      const input = (item.input ?? item.arguments ?? item.params ?? {}) as Record<string, unknown>;
      const skillId = typeof input.id === "string" ? input.id
        : typeof input.name === "string" ? input.name
        : typeof input.skill === "string" ? input.skill
        : null;
      if (skillId && skillId.trim()) {
        sequence.push(skillId.trim().toLowerCase());
        continue;
      }
    }

    // Check if tool name belongs to a known skill prefix
    if (name.includes("::") || name.includes(":")) {
      const prefix = name.split(/[:]/)[0]!.trim().toLowerCase();
      if (prefix && prefix !== "builtin" && prefix !== "tools" && prefix.length > 2) {
        sequence.push(prefix);
      }
    }
  }

  if (!sequence.length && fallbackSkills.length) {
    return [...fallbackSkills.map((s) => s.trim().toLowerCase())];
  }

  return sequence;
}

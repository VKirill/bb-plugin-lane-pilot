export type ResourceMode = "inherit" | "none" | "selected";
export type InventoryStatus = "ready" | "unavailable" | "error";
export type InventoryItem = { name: string; label: string };
export type InventoryGroup = { status: InventoryStatus; items: InventoryItem[]; error?: string };

export const RESOURCE_KEYS = ["tools", "disallowedTools", "skills", "mcpServers"] as const;
export type ResourceKey = (typeof RESOURCE_KEYS)[number];

export function resourceModeOf(value: string[] | undefined): ResourceMode {
  if (value === undefined) return "inherit";
  return value.length === 0 ? "none" : "selected";
}

export function applyResourceMode(mode: ResourceMode | undefined, incoming: string[] | undefined, previous: string[] | undefined): string[] | undefined {
  if (!mode) return incoming ?? previous;
  if (mode === "inherit") return undefined;
  if (mode === "none") return [];
  return incoming ?? [];
}

export function mergeInventoryItems(items: InventoryItem[], saved: string[]): InventoryItem[] {
  const known = new Map(items.map((item) => [item.name, item]));
  for (const name of saved) {
    if (!known.has(name)) known.set(name, { name, label: name });
  }
  return [...known.values()].sort((left, right) => left.label.localeCompare(right.label));
}

export function emptyInventoryGroup(status: InventoryStatus, error?: string): InventoryGroup {
  return { status, items: [], ...(error ? { error } : {}) };
}

export async function collectAgentInventory(input: {
  projectId: string | null;
  listSkills?: (projectId: string) => Promise<Array<{ name: string; pluginId?: string | null }>>;
  listMcp?: () => Promise<Array<{ name: string; sources?: string[] }>>;
}): Promise<{ skills: InventoryGroup; mcpServers: InventoryGroup; tools: InventoryGroup; disallowedTools: InventoryGroup }> {
  const tools = emptyInventoryGroup("unavailable");
  let skills = emptyInventoryGroup(input.listSkills ? "ready" : "unavailable");
  let mcpServers = emptyInventoryGroup(input.listMcp ? "ready" : "unavailable");
  if (input.listSkills) {
    try {
      const listed = await input.listSkills(input.projectId);
      skills = {
        status: "ready",
        items: listed.map((row) => ({ name: row.name, label: row.pluginId ? `${row.name} · ${row.pluginId}` : row.name })),
      };
    } catch (cause) {
      skills = emptyInventoryGroup("error", cause instanceof Error ? cause.message : String(cause));
    }
  }
  if (input.listMcp) {
    try {
      const listed = await input.listMcp();
      mcpServers = {
        status: "ready",
        items: listed.map((row) => ({ name: row.name, label: row.sources?.length ? `${row.name} · ${row.sources.join(", ")}` : row.name })),
      };
    } catch (cause) {
      mcpServers = emptyInventoryGroup("error", cause instanceof Error ? cause.message : String(cause));
    }
  }
  return { skills, mcpServers, tools, disallowedTools: tools };
}

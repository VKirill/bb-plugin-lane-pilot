import { employeeView } from "./employee-manifest";

/**
 * Where an employee thread starts. `threads.spawn` already takes `{ type: "host", hostId, workspace: { type: "unmanaged", path } }`,
 * and a new-thread composer takes the same shape on `experimental_setSelection`. A kernel `experimental_vkHostPlacement` is not needed.
 * An existing chat cannot move host: selection.environment applies to a new thread only.
 */
export type ListedHost = { id: string; name?: string | null };

const normalized = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** The id of the enrolled host whose name the affinity names («mac-mini» ↔ "Mac mini"), or null when no host carries that name. */
export function affinityHostId(affinity: string, hosts: readonly ListedHost[]): string | null {
  const wanted = normalized(affinity);
  if (!wanted) return null;
  return hosts.find((host) => typeof host.name === "string" && normalized(host.name) === wanted)?.id ?? null;
}

export type EmployeePlace =
  | { mode: "inherit" }
  | { mode: "folder"; hostId: string; path: string; created: boolean }
  | { mode: "fallback"; hostId: string; reason: string };

export function chooseEmployeePlace(input: {
  affinity?: string | null;
  hosts: readonly ListedHost[];
  sources: ReadonlyArray<{ hostId?: string | undefined; path?: string | undefined }>;
  hostHome?: string | null;
  agentId: string;
}): EmployeePlace {
  const affinity = input.affinity || "any";
  if (affinity === "any") return { mode: "inherit" };
  const hostId = affinityHostId(affinity, input.hosts);
  if (!hostId) return { mode: "inherit" };
  const source = input.sources.find((row) => row.hostId === hostId && row.path);
  if (source?.path) return { mode: "folder", hostId, path: source.path, created: false };
  if (input.hostHome) {
    const sep = input.hostHome.includes("\\") ? "\\" : "/";
    const path = [input.hostHome.replace(/[\\/]+$/, ""), "LanePilot", "employees", input.agentId].join(sep);
    return { mode: "folder", hostId, path, created: true };
  }
  return { mode: "fallback", hostId, reason: `no project folder and no home on ${affinity}` };
}

type PlaceClient = {
  sdk: {
    hosts: {
      list?: () => Promise<unknown>;
      directory: (input: { hostId: string }) => Promise<{ directory?: string | null }>;
    };
    files: { mkdir: (input: { hostId: string; path: string; recursive?: boolean }) => Promise<unknown> };
  };
};

/** The place for this employee. `any`, an unknown affinity and a name no enrolled host carries stay on the caller's environment. */
export async function placeEmployeeOn(
  bb: PlaceClient,
  agentId: string,
  sources: ReadonlyArray<{ hostId?: string | undefined; path?: string | undefined }>,
): Promise<EmployeePlace> {
  const affinity = employeeView(agentId).machineAffinity;
  if (!affinity || affinity === "any") return { mode: "inherit" };
  const listed = await Promise.resolve(bb.sdk.hosts.list?.()).then((rows) => rows ?? []).catch(() => []) as Array<{ id?: unknown; name?: unknown }>;
  const hosts: ListedHost[] = listed.flatMap((row) => typeof row?.id === "string" ? [{ id: row.id, name: typeof row.name === "string" ? row.name : null }] : []);
  const hostId = affinityHostId(affinity, hosts);
  if (!hostId) return { mode: "inherit" };
  const home = await Promise.resolve()
    .then(() => bb.sdk.hosts.directory({ hostId }))
    .then((row) => row.directory || null)
    .catch(() => null);
  const place = chooseEmployeePlace({ affinity, hosts, sources, hostHome: home, agentId });
  if (place.mode !== "folder" || !place.created) return place;
  try {
    await bb.sdk.files.mkdir({ hostId: place.hostId, path: place.path, recursive: true });
    return place;
  } catch (cause) {
    return { mode: "fallback", hostId: place.hostId, reason: cause instanceof Error ? cause.message : "mkdir failed" };
  }
}

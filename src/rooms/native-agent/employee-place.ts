import { employeeView, type MachineAffinity } from "./employee-manifest";

/**
 * Where an employee thread starts. `threads.spawn` already takes `{ type: "host", hostId, workspace: { type: "unmanaged", path } }`,
 * and a new-thread composer takes the same shape on `experimental_setSelection`. A kernel `experimental_vkHostPlacement` is not needed.
 * An existing chat cannot move host: selection.environment applies to a new thread only.
 */
export const AFFINITY_HOSTS: Record<Exclude<MachineAffinity, "any">, string> = {
  "mac-mini": "host_7sea4qaad8",
  ovh: "host_rwrxyi39aw",
  windows: "host_z8sapas8an",
};

export type EmployeePlace =
  | { mode: "inherit" }
  | { mode: "folder"; hostId: string; path: string; created: boolean }
  | { mode: "fallback"; hostId: string; reason: string };

export function chooseEmployeePlace(input: {
  affinity?: string | null;
  sources: ReadonlyArray<{ hostId?: string | undefined; path?: string | undefined }>;
  hostHome?: string | null;
  agentId: string;
}): EmployeePlace {
  const affinity = input.affinity || "any";
  if (affinity === "any") return { mode: "inherit" };
  const hostId = AFFINITY_HOSTS[affinity as Exclude<MachineAffinity, "any">];
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
    hosts: { directory: (input: { hostId: string }) => Promise<{ directory?: string | null }> };
    files: { mkdir: (input: { hostId: string; path: string; recursive?: boolean }) => Promise<unknown> };
  };
};

/** The place for this employee. `any` and an unknown affinity stay on the caller's environment. */
export async function placeEmployeeOn(
  bb: PlaceClient,
  agentId: string,
  sources: ReadonlyArray<{ hostId?: string | undefined; path?: string | undefined }>,
): Promise<EmployeePlace> {
  const affinity = employeeView(agentId).machineAffinity;
  if (!affinity || affinity === "any") return { mode: "inherit" };
  const hostId = AFFINITY_HOSTS[affinity];
  const home = await Promise.resolve()
    .then(() => bb.sdk.hosts.directory({ hostId }))
    .then((row) => row.directory || null)
    .catch(() => null);
  const place = chooseEmployeePlace({ affinity, sources, hostHome: home, agentId });
  if (place.mode !== "folder" || !place.created) return place;
  try {
    await bb.sdk.files.mkdir({ hostId: place.hostId, path: place.path, recursive: true });
    return place;
  } catch (cause) {
    return { mode: "fallback", hostId: place.hostId, reason: cause instanceof Error ? cause.message : "mkdir failed" };
  }
}

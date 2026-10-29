// (2026-10-29) classifyCliOutcome went with the CLI conveyor. Dirt snapshots stay for writer verification.

export type DirtSnapshot = { path: string; sha256: string };

function asSnapshots(rows: DirtSnapshot[] | string[]): DirtSnapshot[] {
  return rows.map((row) => typeof row === "string" ? { path:row, sha256:"" } : row);
}

export function parseDirtSnapshots(raw: string): DirtSnapshot[] {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      if (typeof item === "string" && item.length > 0) return [{ path:item, sha256:"" }];
      if (item && typeof item === "object" && typeof (item as DirtSnapshot).path === "string") {
        const sha256 = typeof (item as DirtSnapshot).sha256 === "string" ? (item as DirtSnapshot).sha256 : "";
        return [{ path:(item as DirtSnapshot).path, sha256 }];
      }
      return [];
    });
  } catch {
    return [];
  }
}

export function attemptProduced(after: DirtSnapshot[] | string[], before: DirtSnapshot[] | string[]): string[] {
  const afterFiles = asSnapshots(after);
  const beforeFiles = asSnapshots(before);
  const hashed = [...afterFiles, ...beforeFiles].some((file) => file.sha256.length > 0);
  if (!hashed) {
    const previous = new Set(beforeFiles.map((file) => file.path));
    return afterFiles.map((file) => file.path).filter((path) => !previous.has(path));
  }
  const previous = new Map(beforeFiles.map((file) => [file.path, file.sha256]));
  const current = new Map(afterFiles.map((file) => [file.path, file.sha256]));
  const produced = new Set<string>();
  for (const file of afterFiles) {
    if (!previous.has(file.path) || previous.get(file.path) !== file.sha256) produced.add(file.path);
  }
  for (const file of beforeFiles) {
    if (!current.has(file.path)) produced.add(file.path);
  }
  return [...produced];
}

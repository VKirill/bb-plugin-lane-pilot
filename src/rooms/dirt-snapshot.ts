export type DirtSnapshot = { path: string; sha256: string };

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

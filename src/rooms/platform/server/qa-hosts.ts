export type QaHostOption = { id: string; name: string; status: string; connected: boolean };

export function mapListedQaHosts(listed: unknown): QaHostOption[] {
  if (!Array.isArray(listed)) return [];
  const hosts: QaHostOption[] = [];
  for (const item of listed) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id : "";
    if (!id) continue;
    const status = typeof rec.status === "string" ? rec.status : "unknown";
    hosts.push({
      id,
      name: typeof rec.name === "string" && rec.name.trim() ? rec.name : id,
      status,
      connected: status === "connected",
    });
  }
  return hosts;
}

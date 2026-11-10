/** Evidence records (SMA k_lib_evidence): before a risky operation runs — a permit grant, a revert that skips the
 * integration gate, the janitor removing a copy of another owner — the reason given and the checks made go on record,
 * so a person can read afterwards why it ran and what was verified first. Appending never fails the operation: a
 * record that cannot be written is logged and the act goes on. */

export type EvidenceCheck = { name: string; ok: boolean; detail?: string };
export type EvidenceRecord = {
  op: "permit" | "revert" | "janitor";
  projectId: string;
  target: string;
  why: string;
  checks: EvidenceCheck[];
  by: string;
  at: number;
};

type Kv = { get<T>(key: string): Promise<T | null | undefined>; set(key: string, value: never): Promise<unknown> };

const key = (projectId: string) => `evidence:${projectId}`;

/** Append one record. Returns false when the store could not take it (the caller logs and goes on). */
export async function recordEvidence(kv: Kv, record: EvidenceRecord): Promise<boolean> {
  try {
    const list = ((await kv.get<EvidenceRecord[]>(key(record.projectId))) ?? []).concat(record);
    await kv.set(key(record.projectId), list.slice(-500) as never);
    return true;
  } catch {
    return false;
  }
}

/** The records of a project, newest first, optionally filtered by operation and age. */
export async function listEvidence(kv: Kv, projectId: string, opts: { op?: string; days?: number } = {}): Promise<EvidenceRecord[]> {
  const since = opts.days ? Date.now() - opts.days * 86_400_000 : 0;
  return (((await kv.get<EvidenceRecord[]>(key(projectId))) ?? [])
    .filter((row) => (!opts.op || row.op === opts.op) && row.at >= since)
    .sort((a, b) => b.at - a.at));
}

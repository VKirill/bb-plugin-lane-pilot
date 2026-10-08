import type { Db } from "./store";

/**
 * Housekeeping of the memory the learning feeds (T7).
 *
 * Why the note shelves of BB-сервис and SelfyStudio sit at their budget (checked against `packages/memory-core/src/store.ts`): it is
 * the design working, not a fault. A write over the budget hides the least useful notes (`status = expired`) until the new ones fit, so
 * a shelf that receives notes steadily is always at its budget. What the fill figures hide is what the eviction is ordered by: how
 * often a note served a brief and was accepted. On the hub 6 of 352 records had ever been used, so every note ties at zero and the
 * eviction order is the age of the note (oldest first). The table below shows it per project; a shelf at its budget whose notes were
 * never used is cleared in age order, which is why nothing in it lives long. The fix is not in the store but in the supply of usage
 * (the PM's rules and decisions now reach their readers, T4) and in the budgets, which are `memory.note_budget` and
 * `memory.core_budget` of each project.
 *
 * The collector of the retired `memory-profile` plugin is already merged into the shared owner-message collector
 * (`src/anamnesis/owner-messages.ts`), so the plugin itself can stay disabled; its row in `docs/REGISTRY.md` of the BB-сервис root says
 * `running` and must say `disabled`.
 */
export type ShelfFill = {
  projectId: string; notes: number; noteTokens: number; noteBudget: number; noteFill: number;
  core: number; coreTokens: number; coreBudget: number; coreFill: number;
  neverUsedNotes: number; usedNotes: number; expired: number; superseded: number;
};

const tokensOf = (bytes: number | null) => Math.ceil((bytes ?? 0) / 4);

export function memoryFill(db: Db, budgets: (projectId: string) => { noteBudget: number; coreBudget: number }): ShelfFill[] {
  const rows = db.prepare(`SELECT project_id AS projectId, kind, count(*) AS n, sum(length(CAST(content AS BLOB))) AS bytes, sum(CASE WHEN use_count>0 THEN 1 ELSE 0 END) AS used
    FROM lane_pilot_memory WHERE status='active' GROUP BY project_id, kind`).all() as Array<{ projectId: string; kind: string; n: number; bytes: number | null; used: number | null }>;
  const hidden = db.prepare("SELECT project_id AS projectId, status, count(*) AS n FROM lane_pilot_memory WHERE status<>'active' GROUP BY project_id, status").all() as Array<{ projectId: string; status: string; n: number }>;
  const byProject = new Map<string, ShelfFill>();
  const shelf = (projectId: string): ShelfFill => {
    let value = byProject.get(projectId);
    if (!value) {
      const { noteBudget, coreBudget } = budgets(projectId);
      value = { projectId, notes: 0, noteTokens: 0, noteBudget, noteFill: 0, core: 0, coreTokens: 0, coreBudget, coreFill: 0, neverUsedNotes: 0, usedNotes: 0, expired: 0, superseded: 0 };
      byProject.set(projectId, value);
    }
    return value;
  };
  for (const row of rows) {
    const value = shelf(row.projectId);
    if (row.kind === "note") { value.notes = row.n; value.noteTokens = tokensOf(row.bytes); value.usedNotes = row.used ?? 0; value.neverUsedNotes = row.n - (row.used ?? 0); }
    else { value.core = row.n; value.coreTokens = tokensOf(row.bytes); }
  }
  for (const row of hidden) { const value = shelf(row.projectId); if (row.status === "expired") value.expired = row.n; else value.superseded = row.n; }
  for (const value of byProject.values()) {
    value.noteFill = Math.round((value.noteTokens / Math.max(1, value.noteBudget)) * 100) / 100;
    value.coreFill = Math.round((value.coreTokens / Math.max(1, value.coreBudget)) * 100) / 100;
  }
  return [...byProject.values()].sort((a, b) => b.noteFill - a.noteFill);
}

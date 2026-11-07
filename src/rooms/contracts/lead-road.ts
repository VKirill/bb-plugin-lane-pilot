import type { SqlDb } from "./sql-db";

export type RoadDb = SqlDb;
export type RoadKind = "direction" | "option";
export type RoadSource = "owner" | "lead" | "pm" | "wall" | "bench";
export type RoadState = "open" | "proposed" | "accepted" | "later" | "rejected" | "done";
export type RoadEvidence = { kind: "run" | "task" | "file" | "note" | "url" | "metric"; ref: string; label?: string };
export type RoadRow = {
  id: string; parent_id: string | null; project_id: string | null; title: string; kind: RoadKind; source: RoadSource; why: string;
  evidence_json: string; cost_estimate: string | null; class: string | null; state: RoadState;
  proposed_at: number | null; decided_at: number | null; decision_id: string | null; created_at: number; updated_at: number;
  /** What the branch carries to act with (a schedule proposal's schedule); JSON or null. */
  payload_json: string | null;
};

/** The lead's road functions, implemented by src/rooms/lead and injected for the rooms that file or settle a branch. */
export interface LeadRoadApi {
  addRoad(db: RoadDb, input: {
    id?: string; parentId?: string | null; projectId?: string | null; title: string; kind: RoadKind; source: RoadSource;
    why: string; evidence?: RoadEvidence[]; costEstimate?: string | null; class?: string | null; payload?: unknown;
  }, now?: number): RoadRow;
  getRoad(db: RoadDb, id: string): RoadRow | undefined;
  listRoad(db: RoadDb, filter?: { projectId?: string | null; state?: RoadState | RoadState[]; kind?: RoadKind; parentId?: string | null; limit?: number }): RoadRow[];
  doneRoad(db: RoadDb, id: string, note?: string, now?: number): boolean;
  reopenRoad(db: RoadDb, id: string, note: string, now?: number): boolean;
}

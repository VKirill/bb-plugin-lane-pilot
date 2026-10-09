import { WORLD_SCHEMA_VERSION, parseWorld, serializeWorld, type WorldState } from "@lane-pilot/world-sim";
import type { LanePilotDatabase } from "../../storage";

const ROW_ID = "main";

/** The saved world and when it last ticked, or null when none was saved or it is of another schema (a new world is made then). */
export function loadWorld(db: LanePilotDatabase): { world: WorldState; tickAt: number } | null {
  const row = db.prepare("SELECT schema, state_json, tick_at FROM lane_pilot_world WHERE id=?").get(ROW_ID) as { schema: number; state_json: string; tick_at: number } | undefined;
  if (!row || row.schema !== WORLD_SCHEMA_VERSION) return null;
  return { world: parseWorld(row.state_json), tickAt: row.tick_at };
}

/**
 * Saves the world. A reload may start the new instance before the old one has finished disposing; the older tick never
 * overwrites a newer one, so the instance that ticks last wins (the loser's final save is dropped).
 */
export function saveWorld(db: LanePilotDatabase, world: WorldState, tickAt: number, now: number): number {
  const json = serializeWorld(world);
  db.prepare(`INSERT INTO lane_pilot_world(id, schema, state_json, tick_at, saved_at) VALUES (?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET schema=excluded.schema, state_json=excluded.state_json, tick_at=excluded.tick_at, saved_at=excluded.saved_at
    WHERE excluded.tick_at >= lane_pilot_world.tick_at`)
    .run(ROW_ID, world.schema, json, tickAt, now);
  return json.length;
}

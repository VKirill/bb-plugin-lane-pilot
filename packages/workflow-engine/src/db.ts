import type Database from "better-sqlite3";

/** The plugin database as the stores and the engine see it: a better-sqlite3 handle (the storage room's `LanePilotDatabase` is the same type). */
export type LanePilotDatabase = Database.Database;

/** The smallest database handle a port function needs (better-sqlite3's `Database.Database`), without importing the storage room. */
export type SqlDb = Pick<import("better-sqlite3").Database, "prepare" | "transaction">;

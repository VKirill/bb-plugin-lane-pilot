import type Database from "better-sqlite3";
import { createJevClient } from "./client";
import { createJev, type Jev } from "./run";

/**
 * The Jev of this plugin instance. The server installs it once at start (`installJev`, with the Env Catalog key reader and the
 * database) and drops it on dispose; callers ask `jev()` and get null before it is installed, which they treat as «Jev is off»
 * (their deterministic behaviour). Tests install their own with a fake client.
 */
let installed: Jev | null = null;

export const jev = (): Jev | null => installed;

export function installJev(deps: { apiKey(): Promise<string | undefined>; db: Database.Database; log?: (message: string) => void }): () => void {
  const instance = createJev({ client: createJevClient({ apiKey: deps.apiKey }), db: deps.db, ...(deps.log ? { log: deps.log } : {}) });
  installed = instance;
  return () => { if (installed === instance) installed = null; };
}

/** For tests: put a Jev in place (or remove it with null). */
export function setJevForTests(instance: Jev | null): void { installed = instance; }

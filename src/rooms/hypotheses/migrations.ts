/**
 * The register of hypotheses (src/rooms/hypotheses). One table, spread at the END of `migrations` in storage/database.ts.
 *
 * lane_pilot_hypothesis: an idea to make the system better (found outside — a repository, a post, a talk — or inside), written as the settings
 * that would carry it; its bench arms (the baseline and the idea, on one set version) and the verdict. `state`: proposed, benching,
 * adopted (the bench found it not worse and the policy let the night apply it), held (the bench passed, the policy keeps it off the night)
 * or rejected (worse on the bench).
 */
export const hypothesisMigrations: readonly string[] = [
  `CREATE TABLE lane_pilot_hypothesis (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    source TEXT NOT NULL,
    settings_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('proposed','benching','adopted','held','rejected')),
    set_version TEXT,
    verdict_json TEXT,
    previous_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
];

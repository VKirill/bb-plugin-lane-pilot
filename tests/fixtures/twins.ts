/**
 * The test doubles of BB answers that tests share. tests/twins.test.ts checks each one against the recorded shape of the real answer
 * (tests/fixtures/real-shapes): a double may leave keys out, never invent one or change a type (SMA Q13, agent rule 4).
 */
export const TWINS = {
  "threads.get": { id: "thr_x", status: "idle", projectId: "proj_x", createdAt: 1 },
  "providers.list": [{ id: "codex", pluginId: "provider-codex", available: true }],
  "plugins.list": [{ id: "provider-codex", version: "0.1.0", enabled: true }],
} as const;

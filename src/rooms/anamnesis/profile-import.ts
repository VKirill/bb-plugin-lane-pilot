import { z } from "zod";
import type { Evidence } from "./model";

/**
 * The card of the retired `memory-profile` plugin, moved into anamnesis (A9). The plugin kept one small profile (identity, background,
 * preferences, current focus, up to five projects, 1800 characters in all) and put it into every agent's context. Each field
 * becomes one record the owner wrote and confirmed (the card was always the owner's own text), so the PM's card block carries the same
 * facts as before, now with a history and a way to edit and forget each one. Evidence points at the profile version the field came from.
 * Sensitivity is decided by the store's floor, so a field about family or health stops reaching agents the old card showed it to:
 * the owner marks what may be seen (`public`/`private`) in the tab.
 */
export const profileSchema = z.object({
  version: z.number().int().nonnegative().optional(),
  identity: z.string().max(400).optional(), about: z.string().max(700).optional(), preferences: z.string().max(500).optional(), focus: z.string().max(600).optional(),
  focusConfirmedAt: z.number().int().nonnegative().optional(), updatedAt: z.number().int().nonnegative().optional(),
  projects: z.array(z.object({
    key: z.string().max(60).optional(), name: z.string().trim().min(1).max(120), summary: z.string().max(400).optional(),
    status: z.string().max(20).optional(), confirmedAt: z.number().int().nonnegative().optional(),
  }).passthrough()).max(10).optional(),
}).passthrough();
export type MemoryProfile = z.infer<typeof profileSchema>;

const ORIGIN = "memory-profile";

/** The records for the store (`actor: owner`), and the fields that had nothing to move. */
export function profileRecords(profile: MemoryProfile, now: number): { records: Array<Record<string, unknown>>; skipped: string[] } {
  const records: Array<Record<string, unknown>> = [], skipped: string[] = [];
  const version = profile.version ?? 0;
  const evidence = (field: string, at: number | undefined): Evidence[] => [{ source: "manual", ref: `${ORIGIN}:v${version}:${field}`, at: at || profile.updatedAt || now }];
  const field = (name: string, text: string | undefined, record: (text: string) => Record<string, unknown>) => {
    const value = (text ?? "").replace(/\s+/g, " ").trim();
    if (!value) { skipped.push(name); return; }
    records.push(record(value));
  };
  field("identity", profile.identity, (text) => ({ kind: "self", key: "identity", title: text.slice(0, 160), statement: text.slice(0, 600), attributes: { origin: ORIGIN, field: "identity" }, confidence: 1, evidence: evidence("identity", profile.updatedAt) }));
  field("about", profile.about, (text) => ({ kind: "fact", key: "background", title: "Background", statement: text.slice(0, 600), attributes: { origin: ORIGIN, field: "about" }, confidence: 1, evidence: evidence("about", profile.updatedAt) }));
  field("preferences", profile.preferences, (text) => ({ kind: "preference", key: "profile-preferences", title: "Preferences (from the old profile)", statement: text.slice(0, 600), attributes: { origin: ORIGIN, field: "preferences" }, confidence: 1, evidence: evidence("preferences", profile.updatedAt) }));
  field("focus", profile.focus, (text) => ({ kind: "fact", key: "current-focus", title: "Current focus", statement: text.slice(0, 600), attributes: { origin: ORIGIN, field: "focus" }, confidence: 1,
    ...(profile.focusConfirmedAt ? { firstSeen: profile.focusConfirmedAt, lastSeen: profile.focusConfirmedAt } : {}), evidence: evidence("focus", profile.focusConfirmedAt) }));
  for (const project of profile.projects ?? []) {
    records.push({
      kind: "project", key: project.name, title: project.name.slice(0, 160), statement: (project.summary ?? "").replace(/\s+/g, " ").trim().slice(0, 600),
      attributes: { origin: ORIGIN, field: "project", ...(project.status ? { status: project.status } : {}), ...(project.key ? { profileKey: project.key } : {}) }, confidence: 1,
      ...(project.confirmedAt ? { firstSeen: project.confirmedAt, lastSeen: project.confirmedAt } : {}), evidence: evidence(`project:${project.key ?? project.name}`, project.confirmedAt),
    });
  }
  return { records, skipped };
}

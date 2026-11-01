import { z } from "zod";
import policyJson from "../../../../policy/lead-policy.json";
import type { ClassExam } from "../logic";
import type { Db } from "./journal";

/**
 * The rights of the lead by class (roadmap §2.5, §7). The policy file says where a class starts and which classes the owner keeps for
 * himself; the table `lane_pilot_lead_right` holds the tier a class has earned or lost since. The exam is the only writer of the table
 * (`applyExam`), and it never touches an `owner_only` class: that list grows only by the owner's hand in policy/lead-policy.json.
 * A prompt cannot widen a right: `mayAct` reads the table and the file, nothing a session says (tests/lead/rights.test.ts).
 */
export type Tier = "decides" | "proposes" | "owner_only";
export const TIERS: readonly Tier[] = ["decides", "proposes", "owner_only"];
const policySchema = z.object({
  version: z.number().int().positive(),
  frozen_at: z.string(),
  classes: z.array(z.object({ id: z.string().min(1), tier: z.enum(["decides", "proposes", "owner_only"]), description: z.string(), acts_via: z.enum(["intake", "schedule", "none"]) })).min(1),
}).passthrough();
export type LeadPolicy = z.infer<typeof policySchema>;
export const LEAD_POLICY: LeadPolicy = policySchema.parse(policyJson);
export const LEAD_CLASSES: readonly string[] = LEAD_POLICY.classes.map((row) => row.id);

export type RightRow = { class: string; tier: Tier; n: number | null; k: number | null; m: number | null; wilson_lb: number | null; coverage: number | null; kappa: number | null; since: number; policy_version: number | null; last_exam_at: number | null; reasons_json: string };

export const policyTier = (cls: string): Tier => LEAD_POLICY.classes.find((row) => row.id === cls)?.tier ?? "owner_only";
export const actsVia = (cls: string): "intake" | "schedule" | "none" => LEAD_POLICY.classes.find((row) => row.id === cls)?.acts_via ?? "none";

export const readRights = (db: Db): RightRow[] => db.prepare("SELECT * FROM lane_pilot_lead_right ORDER BY class").all() as RightRow[];

/** The tier a class holds now: the table's row when the exam wrote one, else the policy's start; owner_only in the file always wins. */
export function tierOf(db: Db, cls: string): Tier {
  const start = policyTier(cls);
  if (start === "owner_only") return "owner_only";
  const row = db.prepare("SELECT tier FROM lane_pilot_lead_right WHERE class=?").get(cls) as { tier: Tier } | undefined;
  return row?.tier ?? start;
}

/** Every class with its tier and the numbers behind it (the panel, `bb lane-pilot lead rights`). */
export function rightsView(db: Db): Array<{ class: string; tier: Tier; start: Tier; description: string; actsVia: string; exam: RightRow | null }> {
  const rows = new Map(readRights(db).map((row) => [row.class, row]));
  return LEAD_POLICY.classes.map((entry) => ({ class: entry.id, tier: tierOf(db, entry.id), start: entry.tier, description: entry.description, actsVia: entry.acts_via, exam: rows.get(entry.id) ?? null }));
}

/** May the lead act on its own in this class, on this risk? Only a `decides` class, never on risk high, never money or external. */
export function mayAct(db: Db, cls: string, risk: string | null | undefined): { ok: true } | { ok: false; reason: string } {
  const tier = tierOf(db, cls);
  if (tier === "owner_only") return { ok: false, reason: `class ${cls} is owner_only` };
  if (tier === "proposes") return { ok: false, reason: `class ${cls} proposes: the exam has not opened it` };
  if (risk === "high" || risk === "critical") return { ok: false, reason: `risk ${risk} never acts, whatever the tier` };
  return { ok: true };
}

export type TierChange = { class: string; from: Tier; to: Tier; reasons: string[] };

/**
 * The nightly exam writes the table: a class the exam marks `decides` opens; an open class whose recent window degrades (`revert`) or
 * that no longer meets the rules falls back to `proposes`. A class the exam has no rows for keeps its row untouched. Returns the changes.
 */
export function applyExam(db: Db, exams: readonly ClassExam[], now: number = Date.now()): TierChange[] {
  const changes: TierChange[] = [];
  const upsert = db.prepare(`INSERT INTO lane_pilot_lead_right(class,tier,n,k,m,wilson_lb,coverage,kappa,since,policy_version,last_exam_at,reasons_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(class) DO UPDATE SET tier=excluded.tier, n=excluded.n, k=excluded.k, m=excluded.m, wilson_lb=excluded.wilson_lb, coverage=excluded.coverage, kappa=excluded.kappa,
      since=CASE WHEN lane_pilot_lead_right.tier=excluded.tier THEN lane_pilot_lead_right.since ELSE excluded.since END, policy_version=excluded.policy_version, last_exam_at=excluded.last_exam_at, reasons_json=excluded.reasons_json`);
  db.transaction(() => {
    for (const exam of exams) {
      if (policyTier(exam.class) === "owner_only") continue;
      const from = tierOf(db, exam.class);
      const to: Tier = from === "decides" ? (exam.revert || exam.tier !== "decides" ? "proposes" : "decides") : exam.tier;
      const reasons = to === "decides" ? [] : [...exam.reasons, ...(exam.revert ? [`window LB ${exam.windowLb === null ? "—" : exam.windowLb.toFixed(2)} or a high-risk miss in the last ${20}`] : [])];
      upsert.run(exam.class, to, exam.n, exam.k, exam.m, exam.wilsonLb, exam.coverage, exam.kappa, now, LEAD_POLICY.version, now, JSON.stringify(reasons));
      if (from !== to) changes.push({ class: exam.class, from, to, reasons });
    }
  })();
  return changes;
}

import type Database from "better-sqlite3";
import {
  CORE_PROVIDER_GROUPS,
  ROLE_PROFILES,
  parseRequiredSessionPolicyCapability,
  providerPolicyRows,
  type RequiredSessionAdvertisement,
} from "./helper-context";

/**
 * The daily profile check (2026-11-06): around 2026-11-01 the core's advertisement drifted, the plugin's strict parse
 * stopped recognising it, and for five days every helper ran with the full BB context — silently, because nothing read
 * the stored policies back. This check reads them back once a day and says, per helper role, how many threads of the
 * last 24 hours ran with a stored required session policy, how many without one, and how many a parent ceiling cut
 * below the names the role profile lists. On top it reports `get_globals`' `requiredSessionPolicy` (expected
 * «required») and the per-provider advertisement match (providerPolicyRows): a provider row the table cannot match is
 * the same drift that once dropped every profile at once.
 *
 * `coreDb` is BB's own database (`~/.bb/bb.db` on the hub), opened read-only: the check needs `threads` and
 * `thread_plugin_metadata` of the core, which Lane Pilot's own base does not have.
 */
type Db = Pick<Database.Database, "prepare">;
export const PROFILE_CHECK_WINDOW_MS = 24 * 3_600_000;
/** Threads that carry a role but are not helpers to narrow: PM chats are conductors, the provisioner answers «OK», probes are checks. */
const SKIP_ROLES = ["pm", "workspace-provisioner"];
/** More helpers than this in a day means the count itself is the finding; the cap bounds one read of the live base. */
export const HELPER_THREAD_CAP = 5000;

export type HelperThreadRow = { threadId: string; role: string; policyJson: string | null };
export type RolePolicyCount = { role: string; total: number; withPolicy: number; noPolicy: number; narrowed: number };
export type ProviderVerdict = { provider: string; ok: boolean; reason: string | null };
export type ProfileReport = {
  at: number;
  threads: number;
  withPolicy: number;
  noPolicy: number;
  narrowed: number;
  roles: RolePolicyCount[];
  /** What `get_globals` would answer for `requiredSessionPolicy`. */
  requiredSessionPolicy: "required" | "none";
  providers: ProviderVerdict[];
  /** One finding per red fact: a role with a thread without a policy, a capability that is not required, a drifted provider row. */
  red: string[];
  /** Set when the core database could not be read: the day is unknown, not red — no owner item, the morning line says «не проверено». */
  unverified: string | null;
};

/** The unit of `threads.created_at`: milliseconds on the current hub, seconds in older rows. Read once, so the window
 * compares the raw column (no CASE on it) — the same unit question lp-graph-coverage.sql answers inside the query. */
function createdAtUnit(coreDb: Db): number {
  const row = coreDb.prepare("SELECT MAX(created_at) AS at FROM threads").get() as { at: number | null } | undefined;
  return row?.at !== null && row?.at !== undefined && row.at > 100000000000 ? 1 : 1000;
}

/**
 * The slice of BB's core database the check reads: hidden child helpers of the window (`parent_thread_id` set), created
 * by `plugin_id = 'lane-pilot'` exactly, with the stored policy's JSON if any. The window runs on the raw `created_at`
 * in the column's own unit; probes (`helperProbe`) and bench lanes (`lanePilotBench`) are out by marker, not by name —
 * a real writer without a policy stays in. Capped: more than HELPER_THREAD_CAP helpers a day is a finding of its own.
 */
export function helperThreads(coreDb: Db, since: number): HelperThreadRow[] {
  return coreDb.prepare(`SELECT m.thread_id AS threadId, json_extract(m.metadata_json, '$.role') AS role,
      (SELECT p.metadata_json FROM thread_plugin_metadata p WHERE p.thread_id = m.thread_id AND p.plugin_id = '__vk.required-session-policy') AS policyJson
    FROM thread_plugin_metadata m JOIN threads t ON t.id = m.thread_id
    WHERE m.plugin_id = 'lane-pilot'
      AND t.parent_thread_id IS NOT NULL
      AND t.created_at >= ?
      AND json_extract(m.metadata_json, '$.role') IS NOT NULL
      AND json_extract(m.metadata_json, '$.helperProbe') IS NOT 1
      AND json_extract(m.metadata_json, '$.lanePilotBench') IS NOT 1
    LIMIT ${HELPER_THREAD_CAP}`).all(Math.floor(since / createdAtUnit(coreDb))) as HelperThreadRow[];
}

/** The names of one group the stored policy allows; a group the policy does not carry allows nothing (fail closed on reading). */
function policyNames(policyJson: string, group: "skills" | "mcpServers" | "bbPlugins"): string[] | null {
  try {
    const row = (JSON.parse(policyJson) as { policy?: Record<string, { mode?: string; names?: unknown } | undefined> }).policy?.[group];
    return row && row.mode === "allow" && Array.isArray(row.names) ? (row.names as string[]) : null;
  } catch {
    return null;
  }
}

/** A stored policy a parent ceiling narrowed below the role profile: at least one name the profile lists is missing. */
export function narrowedByCeiling(role: string, policyJson: string): boolean {
  const profile = ROLE_PROFILES[role as keyof typeof ROLE_PROFILES];
  if (!profile) return false; // a role without a profile lists nothing to lose
  for (const group of ["skills", "mcpServers", "bbPlugins"] as const) {
    const want = profile[group];
    if (!want?.length) continue;
    const names = policyNames(policyJson, group);
    if (!names || want.some((name) => !names.includes(name))) return true;
  }
  return false;
}

/** Per helper role of the window: threads, with a stored policy, without one, narrowed below the profile. */
export function rolePolicyCounts(threads: readonly HelperThreadRow[]): RolePolicyCount[] {
  const byRole = new Map<string, RolePolicyCount>();
  for (const thread of threads) {
    if (SKIP_ROLES.includes(thread.role)) continue;
    const row = byRole.get(thread.role) ?? { role: thread.role, total: 0, withPolicy: 0, noPolicy: 0, narrowed: 0 };
    row.total += 1;
    if (thread.policyJson === null) row.noPolicy += 1;
    else {
      row.withPolicy += 1;
      if (narrowedByCeiling(thread.role, thread.policyJson)) row.narrowed += 1;
    }
    byRole.set(thread.role, row);
  }
  return [...byRole.values()].sort((a, b) => b.noPolicy - a.noPolicy || b.total - a.total || a.role.localeCompare(b.role));
}

/** `get_globals`' requiredSessionPolicy and the per-provider match over what the core advertises right now. */
export function providerVerdicts(agents: { experimental_vkRequiredSessionPolicy?: unknown }): { advertised: RequiredSessionAdvertisement | null; providers: ProviderVerdict[] } {
  const advertised = parseRequiredSessionPolicyCapability(agents);
  if (!advertised) return { advertised: null, providers: [] };
  const ids = new Set([...Object.keys(CORE_PROVIDER_GROUPS), ...Object.keys(advertised.providerGroups), ...Object.keys(advertised.instructionSwitches)]);
  const providers = [...ids].sort().map((provider): ProviderVerdict => {
    const rows = providerPolicyRows(advertised, provider);
    // A provider the core does not host under required policies is "not advertised": not drift, another provider is picked instead.
    return rows.ok ? { provider, ok: true, reason: null } : { provider, ok: false, reason: rows.advertised ? rows.reason : "not advertised" };
  });
  return { advertised, providers };
}

/** The verdict: a thread of a helper role without a policy, a capability below «required», a drifted provider row. */
export function buildProfileReport(input: { threads: readonly HelperThreadRow[]; agents: { experimental_vkRequiredSessionPolicy?: unknown }; now: number }): ProfileReport {
  const roles = rolePolicyCounts(input.threads);
  const { providers } = providerVerdicts(input.agents);
  const red: string[] = [];
  for (const row of roles) if (row.noPolicy > 0) red.push(`роль «${row.role}»: ${row.noPolicy} из ${row.total} потоков без обязательной политики`);
  const requiredSessionPolicy = parseRequiredSessionPolicyCapability(input.agents) ? ("required" as const) : ("none" as const);
  if (requiredSessionPolicy !== "required") red.push(`requiredSessionPolicy «${requiredSessionPolicy}», ожидалось «required»`);
  for (const row of providers) if (!row.ok && row.reason !== "not advertised") red.push(`провайдер «${row.provider}»: строка advertisement не совпадает (${row.reason})`);
  return {
    at: input.now,
    threads: roles.reduce((sum, row) => sum + row.total, 0),
    withPolicy: roles.reduce((sum, row) => sum + row.withPolicy, 0),
    noPolicy: roles.reduce((sum, row) => sum + row.noPolicy, 0),
    narrowed: roles.reduce((sum, row) => sum + row.narrowed, 0),
    roles,
    requiredSessionPolicy,
    providers,
    red,
    unverified: null,
  };
}

/** The verdict persisted: one row a day keeps the morning line and the history without touching the catalog. */
export function saveProfileCheck(db: Db & { prepare: Database.Database["prepare"] }, report: ProfileReport): void {
  db.prepare("INSERT INTO lane_pilot_profile_check(at, report_json) VALUES (?, ?)").run(report.at, JSON.stringify(report));
}

/** The last check's report, or null before the first run. */
export function latestProfileCheck(db: Db): ProfileReport | null {
  try {
    const row = db.prepare("SELECT report_json FROM lane_pilot_profile_check ORDER BY at DESC LIMIT 1").get() as { report_json: string } | undefined;
    return row ? (JSON.parse(row.report_json) as ProfileReport) : null;
  } catch {
    return null;
  }
}

/** One line for the wall morning summary: the day's verdict, or nothing before the first check. */
export function profileCheckMorningLine(db: Db): string | null {
  const report = latestProfileCheck(db);
  if (!report) return null;
  if (report.unverified) return `Профили ролей: не проверено (база ядра недоступна: ${report.unverified.slice(0, 120)}).`;
  const counts = `потоков помощников ${report.threads} (политика у ${report.withPolicy}, без ${report.noPolicy}, сужено потолком ${report.narrowed})`;
  const providers = `провайдеры ${report.providers.filter((row) => row.ok).length}/${report.providers.length}`;
  return report.red.length
    ? `Профили ролей КРАСНОЕ: ${report.red.join("; ")} (${counts}, requiredSessionPolicy «${report.requiredSessionPolicy}», ${providers}).`
    : `Профили ролей: зелёное — ${counts}, requiredSessionPolicy «required», ${providers} в норме.`;
}

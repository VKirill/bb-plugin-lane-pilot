import type Database from "better-sqlite3";
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { latestProfileCheckReportJson, saveProfileCheckReport } from "../storage";
import {
  CORE_PROVIDER_GROUPS,
  ROLE_PROFILES,
  parseRequiredSessionPolicyCapability,
  providerPolicyRows,
  type RequiredSessionAdvertisement,
} from "../contracts/helper-context";

/**
 * The daily profile check (2026-11-06): around 2026-11-01 the core's advertisement drifted, the plugin's strict parse
 * stopped recognising it, and for five days every helper ran with the full BB context — silently, because nothing read
 * the stored policies back. This check reads them back once a day and says, per helper role, how many threads of the
 * last 24 hours ran with a stored required session policy, how many without one, and how many carry a stored policy
 * already narrower than the names the role profile lists (the stored field does not record the cause). On top it reports `get_globals`' `requiredSessionPolicy` (expected
 * «required») and the per-provider advertisement match (providerPolicyRows): a provider row the table cannot match is
 * the same drift that once dropped every profile at once.
 *
 * `threads` and `thread_plugin_metadata` are the core's, not Lane Pilot's: the runtime read goes through the SDK
 * (`helperThreadsViaSdk`), never through a second SQLite copy of BB's `bb.db` inside this process. The stored-policy
 * half reads the optional `threads.experimental_vkInspectRequiredSessionPolicies` (VK core P2): it reports the
 * STORED required snapshot — presence and content — not proof the provider enforced it at runtime.
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
  /** The SDK window's known boundary, stated every day: archived and hidden threads are listed, deleted threads are not — helpers deleted inside the window are not covered. */
  coverageNote: string;
};

/**
 * The same slice through the SDK, no core database: `threads.list` finds child threads carrying Lane Pilot metadata
 * (`hasParent` + `includeHidden`, every origin — the old SQL keyed on `thread_plugin_metadata.plugin_id`, not on who
 * spawned the thread, so an originPluginId filter would silently drop foreign-origin helpers), and
 * `experimental_listPluginMetadata` reads the `lane-pilot` metadata (role and the probe/bench markers) in
 * ceil(N/200) calls, and counted helper roles get their stored required-session-policy snapshot from the optional
 * `experimental_vkInspectRequiredSessionPolicies` in ceil(N/200) calls. On a host without that method a day with
 * counted helpers throws (the caller reports «не проверено», never a fabricated noPolicy/red); a day with only
 * non-counted roles keeps its valid empty count and never calls it. No bb.db fallback, no raw `__vk.*` metadata
 * request, no inference from capability advertisement. Archived threads are included (the route's default covers
 * both groups); deleted threads are always excluded by `threads.list`, so helpers deleted inside the window are not
 * covered — the report says so in `coverageNote`, it does not pretend the window is complete. Any malformed,
 * partial or unverified inspection answer throws, so the caller marks the day unverified; a page cap that is hit
 * also throws rather than silently reporting a partial window as complete.
 */
const SDK_LIST_PAGE = 200;
const SDK_LIST_MAX_PAGES = 25;
const METADATA_CHUNK = 200;
const INSPECT_CHUNK = 200;

/**
 * The npm SDK (0.6.104) predates the VK method, so `api` is typed structurally: one optional method returning
 * `unknown`, validated below against the frozen v1 contract of core `vk-required-session-policy-inspection.ts`
 * (mirrored from the generated `bb-plugin-sdk.d.ts`). Unknown fields anywhere reject the whole chunk.
 */
type PolicyInspectionApi = {
  experimental_vkInspectRequiredSessionPolicies?: (args: {
    threadIds: string[];
  }) => Promise<unknown>;
};

// Core value bounds (vk-session-policy.ts): names are canonical in stored output — trimmed, nonempty,
// ≤200 chars; ≤500 names per filter; ≤64 allOf clauses, non-recursive. This validates producer output,
// so noncanonical edge whitespace rejects rather than silently trims like the writer-side schema does.
const storedPolicyName = z
  .string()
  .min(1)
  .max(200)
  .refine((name) => name === name.trim());
const storedPolicyClause = z
  .object({ mode: z.enum(["allow", "deny"]), names: z.array(storedPolicyName).max(500) })
  .strict();
const storedPolicyFilter = storedPolicyClause
  .extend({ allOf: z.array(storedPolicyClause).max(64).optional() })
  .strict();
const storedSessionPolicy = z
  .object({
    bbPlugins: storedPolicyFilter.optional(),
    skills: storedPolicyFilter.optional(),
    mcpServers: storedPolicyFilter.optional(),
    nativePlugins: storedPolicyFilter.optional(),
    userInstructions: z.boolean().optional(),
    projectInstructions: z.boolean().optional(),
    claudeAiSync: z.boolean().optional(),
  })
  .strict();
const storedPolicySnapshot = z
  .object({
    version: z.literal(1),
    policy: storedSessionPolicy,
    ceiling: storedSessionPolicy.optional(),
  })
  .strict();
const policyInspectionResult = z.union([
  z
    .object({
      threadId: z.string(),
      status: z.literal("valid"),
      snapshot: storedPolicySnapshot,
    })
    .strict(),
  z.object({ threadId: z.string(), status: z.literal("absent") }).strict(),
  z
    .object({
      threadId: z.string(),
      status: z.literal("invalid"),
      reason: z.enum([
        "incomplete_snapshot",
        "malformed_snapshot",
        "digest_mismatch",
      ]),
    })
    .strict(),
  z.object({ threadId: z.string(), status: z.literal("unavailable") }).strict(),
]);
const policyInspectionResponse = z
  .object({ version: z.literal(1), results: z.array(policyInspectionResult) })
  .strict();

/**
 * One bounded read of the stored required-session-policy rows for `ids` (already capped). Returns
 * threadId → policyJson (`{policy}` row shape, `null` for a confirmed absent) or throws — a malformed
 * shape, a wrong/duplicate/missing id set, an `invalid`/`unavailable` entry or a rejected call all
 * mean the day's observation is unverified, never partially green.
 */
async function inspectStoredPolicies(
  api: unknown,
  ids: readonly string[],
): Promise<Map<string, string | null>> {
  // The stock SDK threads area shares no declared properties with this all-optional shape, so it
  // arrives as `unknown` and narrows here; `callable` is the same object, so the method call below
  // keeps the receiver (and any binding the core wrapper installed) intact.
  const callable = api as PolicyInspectionApi;
  if (typeof callable.experimental_vkInspectRequiredSessionPolicies !== "function") {
    throw new Error(
      "helper session-policy inspection unsupported: this BB has no threads.experimental_vkInspectRequiredSessionPolicies (optional VK core API)",
    );
  }
  const out = new Map<string, string | null>();
  const unverified = new Map<string, number>();
  const note = (key: string) => unverified.set(key, (unverified.get(key) ?? 0) + 1);
  for (let i = 0; i < ids.length; i += INSPECT_CHUNK) {
    const chunk = ids.slice(i, i + INSPECT_CHUNK);
    // Method call on `api`, not a detached reference: the wrapper binds the plugin identity.
    const reply = policyInspectionResponse.safeParse(
      await callable.experimental_vkInspectRequiredSessionPolicies!({
        threadIds: [...chunk],
      }),
    );
    if (!reply.success) {
      throw new Error(
        "experimental_vkInspectRequiredSessionPolicies returned a malformed response",
      );
    }
    const { results } = reply.data;
    if (results.length !== chunk.length) {
      throw new Error(
        `experimental_vkInspectRequiredSessionPolicies answered ${results.length} results for ${chunk.length} ids`,
      );
    }
    const seen = new Set<string>();
    for (const result of results) {
      if (seen.has(result.threadId)) {
        throw new Error(
          `experimental_vkInspectRequiredSessionPolicies repeated id ${result.threadId}`,
        );
      }
      seen.add(result.threadId);
    }
    for (const id of chunk) {
      if (!seen.has(id)) {
        throw new Error(
          `experimental_vkInspectRequiredSessionPolicies missed id ${id}`,
        );
      }
    }
    for (const result of results) {
      if (result.status === "valid") {
        out.set(
          result.threadId,
          JSON.stringify({ policy: result.snapshot.policy }),
        );
      } else if (result.status === "absent") {
        out.set(result.threadId, null);
      } else if (result.status === "invalid") {
        note(`invalid:${result.reason}`);
      } else {
        note("unavailable");
      }
    }
  }
  if (unverified.size > 0) {
    const detail = [...unverified.entries()]
      .map(([key, count]) => `${count} ${key}`)
      .join(", ");
    throw new Error(`stored policy unverified: ${detail}`);
  }
  return out;
}

export async function helperThreadsViaSdk(bb: BbPluginApi, since: number): Promise<HelperThreadRow[]> {
  const api = bb.sdk.threads;
  if (typeof api.list !== "function" || typeof api.experimental_listPluginMetadata !== "function") {
    throw new Error("this BB has no batched plugin-metadata read (SDK threads.experimental_listPluginMetadata)");
  }
  // Page until a short page proves the list exhausted; the route orders by project/pinned/createdAt-desc, not globally
  // by createdAt, so every row's timestamp is checked and no early stop is possible. Hitting the page cap means the
  // window cannot be proven complete — that is unverified, not a partial green.
  const candidates: string[] = [];
  for (let page = 0; page < SDK_LIST_MAX_PAGES; page += 1) {
    const rows = await api.list({ hasParent: true, includeHidden: true, limit: SDK_LIST_PAGE, offset: page * SDK_LIST_PAGE });
    if (!Array.isArray(rows)) throw new Error("threads.list returned a non-array response");
    for (const row of rows) {
      if (typeof row.createdAt === "number" && row.createdAt >= since) candidates.push(row.id);
    }
    if (rows.length < SDK_LIST_PAGE) break;
    if (page === SDK_LIST_MAX_PAGES - 1) throw new Error(`more than ${SDK_LIST_MAX_PAGES * SDK_LIST_PAGE} child threads; the profile window cannot be read completely`);
  }
  const metadataFor = async (ids: readonly string[]): Promise<Map<string, Record<string, unknown>>> => {
    const out = new Map<string, Record<string, unknown>>();
    for (let i = 0; i < ids.length; i += METADATA_CHUNK) {
      const chunk = ids.slice(i, i + METADATA_CHUNK);
      const result = await api.experimental_listPluginMetadata({ threadIds: chunk });
      if (!Array.isArray(result?.threads)) throw new Error("experimental_listPluginMetadata returned a malformed response");
      for (const row of result.threads) {
        if (typeof row.threadId === "string" && row.metadata && typeof row.metadata === "object") out.set(row.threadId, row.metadata);
      }
    }
    return out;
  };
  const lpMeta = await metadataFor(candidates);
  const withRole = candidates.filter((id) => {
    const meta = lpMeta.get(id);
    if (!meta || meta.role == null) return false;
    // json_extract('true') is 1 in SQLite: the SQL excluded marker === 1, which covers JSON true as well.
    if (meta.helperProbe === 1 || meta.helperProbe === true || meta.lanePilotBench === 1 || meta.lanePilotBench === true) return false;
    return true;
  });
  const rows: HelperThreadRow[] = [];
  const toInspect: string[] = [];
  for (const threadId of withRole) {
    if (rows.length >= HELPER_THREAD_CAP) break;
    const meta = lpMeta.get(threadId)!;
    const role = String(meta.role);
    rows.push({ threadId, role, policyJson: null });
    // SDK-UP01 resolved by the optional core inspection: pm/provisioner/probe rows carry no policy need and are
    // never sent; only counted roles go to `experimental_vkInspectRequiredSessionPolicies`.
    if (!SKIP_ROLES.includes(role)) toInspect.push(threadId);
  }
  if (toInspect.length > 0) {
    const policies = await inspectStoredPolicies(api, toInspect);
    for (const row of rows) {
      if (policies.has(row.threadId)) row.policyJson = policies.get(row.threadId)!;
    }
  }
  return rows;
}

/**
 * One private mirror of the core predicate (`vkPolicyNameMatches`/`vkPolicyAllows`,
 * bb-core/vk packages/domain/src/vk-session-policy.ts): the SDK exports neither, so the check keeps its own copy.
 * Exact name or trailing-`*` prefix; an absent filter allows everything; every `allOf` clause must allow; allow =
 * any candidate spelling matches any pattern, deny = none matches. All spellings of one item go in ONE call —
 * never an OR of per-spelling verdicts.
 */
type StoredFilter = { mode?: unknown; names?: unknown; allOf?: unknown };

function policyNameMatches(pattern: string, name: string): boolean {
  return pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : pattern === name;
}

function filterAllows(filter: StoredFilter | undefined, ...names: readonly string[]): boolean {
  if (filter === undefined || filter === null || typeof filter !== "object") return true;
  const allOf = Array.isArray(filter.allOf) ? (filter.allOf as StoredFilter[]) : [];
  if (allOf.some((clause) => !filterAllows(clause, ...names))) return false;
  const patterns = Array.isArray(filter.names) ? (filter.names as unknown[]).filter((n): n is string => typeof n === "string") : [];
  const listed = names.some((name) => patterns.some((pattern) => policyNameMatches(pattern, name)));
  return filter.mode === "deny" ? !listed : listed;
}

/**
 * A stored policy already narrower than the role profile: at least one name the profile lists is not
 * allowed. (Exported name kept for API compatibility — it compares the stored `policy`, not a proven
 * ceiling.) The stored snapshot does not record WHY it is narrower: an owner request, an inherited
 * ceiling, a compiled agent's own selection or a dynamic resolver can all produce the same field, so
 * the count is stored presence only — it neither attributes a parent ceiling nor claims the provider
 * enforced anything.
 */
export function narrowedByCeiling(role: string, policyJson: string): boolean {
  const profile = ROLE_PROFILES[role as keyof typeof ROLE_PROFILES];
  if (!profile) return false; // a role without a profile lists nothing to lose
  type StoredPolicyGroups = Partial<
    Record<"skills" | "mcpServers" | "bbPlugins", StoredFilter>
  >;
  let policy: StoredPolicyGroups;
  try {
    policy =
      (JSON.parse(policyJson) as { policy?: StoredPolicyGroups }).policy ?? {};
  } catch {
    return true; // unparsable stored policy cannot prove the profile names survived — fail closed
  }
  for (const group of ["skills", "mcpServers", "bbPlugins"] as const) {
    const want = profile[group];
    if (!want?.length) continue;
    if (want.some((name) => !filterAllows(policy[group], name))) return true;
  }
  return false;
}

/** Per helper role of the window: threads, with a stored policy, without one, with a stored policy narrower than the profile. */
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
    coverageNote:
      "SDK threads.list covers archived and hidden threads; deleted threads are always excluded — helpers deleted inside the window are not counted. Policy inspection reads the STORED required snapshot (presence/content), not proof the provider enforced it; `narrowed` counts a stored policy already below the role profile — the stored field does not record the cause (owner request, inheritance, compiled selection or dynamic narrowing); a policy listing only the qualified plugin:skill spelling of a profile name reads as narrowed (alias not expanded)",
  };
}

/** The verdict persisted: one row a day keeps the morning line and the history without touching the catalog. */
export function saveProfileCheck(db: Db & { prepare: Database.Database["prepare"] }, report: ProfileReport): void {
  saveProfileCheckReport(db as never, report.at, JSON.stringify(report));
}

/** The last check's report, or null before the first run. */
export function latestProfileCheck(db: Db): ProfileReport | null {
  try {
    const json = latestProfileCheckReportJson(db as never);
    return json ? (JSON.parse(json) as ProfileReport) : null;
  } catch {
    return null;
  }
}

/** One line for the wall morning summary: the day's verdict, or nothing before the first check. */
export function profileCheckMorningLine(db: Db): string | null {
  const report = latestProfileCheck(db);
  if (!report) return null;
  if (report.unverified) return `Профили ролей: не проверено (база ядра недоступна: ${report.unverified.slice(0, 120)}).`;
  const counts = `потоков помощников ${report.threads} (политика у ${report.withPolicy}, без ${report.noPolicy}, сохранённая политика уже профиля ${report.narrowed})`;
  const providers = `провайдеры ${report.providers.filter((row) => row.ok).length}/${report.providers.length}`;
  return report.red.length
    ? `Профили ролей КРАСНОЕ: ${report.red.join("; ")} (${counts}, requiredSessionPolicy «${report.requiredSessionPolicy}», ${providers}).`
    : `Профили ролей: зелёное — ${counts}, requiredSessionPolicy «required», ${providers} в норме.`;
}

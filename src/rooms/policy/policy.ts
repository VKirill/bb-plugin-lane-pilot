import { posix } from "node:path";
import { z } from "zod";
import policyJson from "../../../policy/night-policy.json";

/**
 * The night policy: which kinds of change the night may settle alone, which it only proposes (a short morning list, never a block),
 * and which are the owner's alone. The lists live in policy/night-policy.json; this file reads them and classifies a change
 * descriptor. Rule: the most restrictive match wins, and a change nothing matches is a proposal.
 */
export const TIERS = ["night_decides", "night_proposes", "owner_only"] as const;
export type Tier = (typeof TIERS)[number];
/** Higher is more restrictive. */
export const RESTRICTION: Record<Tier, number> = { night_decides: 0, night_proposes: 1, owner_only: 2 };

export type Scalar = string | number | boolean;
export type ChangeDescriptor = {
  /** What the change is: lp_fault_repair, rule_adopt, setting_change, data_delete, … */
  kind?: string;
  /** Repository-relative paths the change touches. */
  files?: readonly string[];
  /** Setting keys the change writes. */
  settings?: readonly string[];
  /** Database tables the change writes. */
  tables?: readonly string[];
  /** Proofs and facts about the change: bench_subset_passed, auto_revertible, always_on, irreversible, … */
  attrs?: Readonly<Record<string, Scalar>>;
};

const scalar = z.union([z.string(), z.number(), z.boolean()]);
const matcherSchema = z.object({
  kinds: z.array(z.string().min(1)).min(1).optional(),
  files_any: z.array(z.string().min(1)).min(1).optional(),
  files_all: z.array(z.string().min(1)).min(1).optional(),
  settings_any: z.array(z.string().min(1)).min(1).optional(),
  tables_any: z.array(z.string().min(1)).min(1).optional(),
  attrs: z.record(z.string(), scalar).optional(),
}).strict().refine((matcher) => Object.keys(matcher).length > 0, "a matcher with no field would match every change");
export type Matcher = z.infer<typeof matcherSchema>;

const entrySchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  description: z.string().min(1),
  examples: z.array(z.string().min(1)).min(1),
  match: z.array(matcherSchema).min(1),
}).strict();
export type PolicyEntry = z.infer<typeof entrySchema>;

const designItemSchema = z.object({ id: z.string().regex(/^d\d+$/), source: z.string().min(1), date: z.string(), quote: z.string().min(1), informs: z.array(z.string()).min(1) }).strict();

export const policySchema = z.object({
  version: z.number().int().positive(),
  exam: z.object({ file: z.string(), min_accuracy: z.number().min(0).max(1) }).passthrough(),
  design_items: z.array(designItemSchema).min(1),
  night_decides: z.array(entrySchema),
  night_proposes: z.array(entrySchema),
  owner_only: z.array(entrySchema).min(1),
}).passthrough();
export type Policy = z.infer<typeof policySchema>;

export function parsePolicy(raw: unknown): Policy {
  const policy = policySchema.parse(raw);
  const ids = [...policy.night_decides, ...policy.night_proposes, ...policy.owner_only].map((entry) => entry.id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate) throw new Error(`policy entry id «${duplicate}» appears twice`);
  return policy;
}

/** The policy committed with this build. */
export const POLICY: Policy = parsePolicy(policyJson);

/* ---- matching ---- */

/** A path as the matcher sees it: lower case, slashes forward, ./ and .. resolved. A path that leaves the repository keeps its leading ../. */
export function normalizePath(file: string): string {
  const slashed = file.trim().replace(/\\/g, "/").toLowerCase();
  if (slashed.startsWith("/")) return `/${posix.normalize(slashed).replace(/^\/+/, "")}`;
  const clean = posix.normalize(slashed);
  return clean === "." ? "" : clean;
}

const globCache = new Map<string, RegExp>();
function globRegex(glob: string): RegExp {
  const key = glob.toLowerCase();
  const cached = globCache.get(key);
  if (cached) return cached;
  let source = "";
  for (let index = 0; index < key.length; index++) {
    const char = key[index]!;
    if (char === "*") {
      if (key[index + 1] === "*") {
        index++;
        if (key[index + 1] === "/") { index++; source += "(?:.*/)?"; } else source += ".*";
      } else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else source += char.replace(/[\\^$.|+(){}[\]]/g, "\\$&");
  }
  const regex = new RegExp(`^${source}$`);
  globCache.set(key, regex);
  return regex;
}
export const globMatch = (glob: string, file: string): boolean => globRegex(glob).test(normalizePath(file));

const scalarEquals = (have: Scalar | undefined, want: Scalar): boolean => have !== undefined && have === want;

export function matcherMatches(matcher: Matcher, change: ChangeDescriptor): boolean {
  if (matcher.kinds && !(change.kind !== undefined && matcher.kinds.includes(change.kind))) return false;
  const files = change.files ?? [];
  if (matcher.files_any && !files.some((file) => matcher.files_any!.some((glob) => globMatch(glob, file)))) return false;
  if (matcher.files_all && !(files.length > 0 && files.every((file) => matcher.files_all!.some((glob) => globMatch(glob, file))))) return false;
  if (matcher.settings_any && !(change.settings ?? []).some((key) => matcher.settings_any!.some((glob) => globMatch(glob, key)))) return false;
  if (matcher.tables_any && !(change.tables ?? []).some((table) => matcher.tables_any!.includes(table))) return false;
  if (matcher.attrs && !Object.entries(matcher.attrs).every(([key, want]) => scalarEquals(change.attrs?.[key], want))) return false;
  return true;
}

export type Classification = { tier: Tier; matched: Array<{ id: string; tier: Tier }>; reason: string };

/** The tier and every entry that matched, for the morning list and the exam. */
export function explainChange(change: ChangeDescriptor, policy: Policy = POLICY): Classification {
  const matched: Classification["matched"] = [];
  for (const tier of TIERS) {
    for (const entry of policy[tier]) if (entry.match.some((matcher) => matcherMatches(matcher, change))) matched.push({ id: entry.id, tier });
  }
  if (!matched.length) return { tier: "night_proposes", matched, reason: "no entry matches: unknown changes are proposals" };
  const tier = matched.reduce<Tier>((worst, hit) => (RESTRICTION[hit.tier] > RESTRICTION[worst] ? hit.tier : worst), "night_decides");
  const decisive = matched.filter((hit) => hit.tier === tier).map((hit) => hit.id).join(", ");
  return { tier, matched, reason: `${tier} by ${decisive}${matched.length > 1 ? " (most restrictive of " + matched.map((hit) => hit.id).join(", ") + ")" : ""}` };
}

/** night_decides, night_proposes or owner_only: the most restrictive match wins; unknown is night_proposes. */
export const classifyChange = (change: ChangeDescriptor, policy: Policy = POLICY): Tier => explainChange(change, policy).tier;

/**
 * Whether a folder is worth keeping docs for, decided per place (machine + folder): the same section can be an
 * advertiser's artifacts on one machine and a working codebase on another. Code settles the clear cases from what
 * the folder is made of; System One judges only the borderline ones.
 */
export type DocsWorthinessFacts = {
  status: "ready" | "not-git" | "failed";
  trackedFiles: number;
  codeFiles: number;
  testFiles: number;
  contentFiles: number;
  languages: Array<{ ext: string; files: number }>;
  commits30d: number;
  manifests: string[];
  deploy: boolean;
  docsPages: number;
};

export type DocsVerdictReason = "code_project" | "large_codebase" | "not_git" | "no_code" | "inactive" | "jev_needed" | "jev_not_needed" | "fallback";
export type DocsVerdict = { need: boolean; reason: DocsVerdictReason; confidence: number | null };

/** Below this many code files without a package manifest a folder is scripts, not a product. */
export const DOCS_SMALL_CODE = 15;
/** From this many code files a folder is a codebase whatever else it holds. */
export const DOCS_LARGE_CODE = 50;

/** The clear cases; null means System One decides. */
export function codeDocsVerdict(facts: DocsWorthinessFacts): DocsVerdict | null {
  if (facts.status !== "ready") return { need: false, reason: "not_git", confidence: 1 };
  if (facts.codeFiles === 0) return { need: false, reason: "no_code", confidence: 1 };
  // Docs for a folder nobody works on and that never had them would be written once and never read.
  if (facts.commits30d === 0 && facts.docsPages === 0) return { need: false, reason: "inactive", confidence: 1 };
  if (facts.manifests.length > 0 && facts.codeFiles >= 5) return { need: true, reason: "code_project", confidence: 1 };
  if (facts.codeFiles >= DOCS_LARGE_CODE) return { need: true, reason: "large_codebase", confidence: 1 };
  return null;
}

export const DOCS_WORTHINESS_QUESTION = {
  instructions: "Is it worth keeping developer documentation (architecture, modules, how to run and change it) for this folder?",
  criteria: {
    needed: "the folder holds working code that people or agents keep changing: scripts, services, a site or bot with logic worth explaining",
    not_needed: "the folder is mostly content or artifacts (texts, tables, media, templates, reports) or a handful of throwaway scripts nobody needs explained",
  },
} as const;

/** What System One reads: the facts with their meaning spelled out. */
export function docsWorthinessState(facts: DocsWorthinessFacts, place: { path: string }): Record<string, unknown> {
  return {
    folder: place.path,
    code_files: facts.codeFiles, test_files: facts.testFiles, content_files: facts.contentFiles,
    main_code_languages: facts.languages, package_manifests: facts.manifests.slice(0, 10), runs_somewhere: facts.deploy,
    commits_in_last_30_days: facts.commits30d, existing_docs_pages: facts.docsPages,
    note: "content_files counts texts, tables, media and HTML that are not code",
  };
}

/** Without an answer the bar is the plain size of the code. */
export function fallbackDocsVerdict(facts: DocsWorthinessFacts): DocsVerdict {
  return { need: facts.codeFiles >= DOCS_SMALL_CODE, reason: "fallback", confidence: null };
}

/** The facts that change a verdict when they move: a stored verdict is asked again when this key changes. */
export function docsFactsKey(facts: DocsWorthinessFacts): string {
  const bucket = (n: number) => n === 0 ? "0" : n < 5 ? "<5" : n < DOCS_SMALL_CODE ? "<15" : n < DOCS_LARGE_CODE ? "<50" : "50+";
  return [facts.status, bucket(facts.codeFiles), facts.manifests.length > 0 ? "m" : "-", facts.commits30d > 0 ? "a" : "-", facts.docsPages > 0 ? "d" : "-"].join("|");
}

export type DocsCadence = "nightly" | "weekly" | "paused";

/** Docs nobody reads go quiet: weekly after 60 days without a read, paused after 120. Reads bring them back. */
export const DOCS_QUIET_AFTER_MS = 60 * 24 * 3_600_000;
export const DOCS_PAUSE_AFTER_MS = 120 * 24 * 3_600_000;

export function docsCadence(input: { lastReadAt: number | null; docsSince: number; now: number }): DocsCadence {
  const since = Math.max(input.lastReadAt ?? 0, input.docsSince);
  const quiet = input.now - since;
  if (quiet >= DOCS_PAUSE_AFTER_MS) return "paused";
  if (quiet >= DOCS_QUIET_AFTER_MS) return "weekly";
  return "nightly";
}

/** A weekly folder gets its pass on Mondays of its own machine's calendar. */
export function cadenceAllowsToday(cadence: DocsCadence, localDate: string): boolean {
  if (cadence === "nightly") return true;
  if (cadence === "paused") return false;
  return new Date(`${localDate}T12:00:00Z`).getUTCDay() === 1;
}
